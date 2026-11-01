import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryError, testEvent } from "../src/alerts/operatorEvents";
import type { ToParent, ToWorker } from "../src/hosted/ipc";
import { RelaySink } from "../src/alerts/operatorEvents";
import type { TwilioClient } from "../src/messaging/twilio/client";
import { readTwilioEnv, TwilioMessagingProvider } from "../src/messaging/twilio/provider";
import { WORKER_KEY_HEADER } from "../src/web/server";

/** The touring process as the shared service starts it. Only 555 numbers; Twilio is never called for real. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "src/hosted/touringWorker.ts");
const KEY = "k-entry-test-worker-key-0123456789";
const LINE = "+15555550150";
const VISITOR = "+15555550177";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

async function forkWorker(extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "tourcore-entry-"));
  const child: ChildProcess = fork(ENTRY, [], {
    cwd: ROOT,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER",
      TOURCORE_WORKER_KEY: KEY,
      TOURCORE_HOME: home,
      PUBLIC_BASE_URL: "https://shared.up.railway.app/t/tnt_aaaaaaaaaa",
      TOURCORE_MESSAGING_PROVIDER: "twilio",
      TOURCORE_TWILIO_ACCOUNT_SID: "ACentrytest",
      TOURCORE_TWILIO_AUTH_TOKEN: "entry-twilio-auth",
      TOURCORE_TWILIO_PHONE_NUMBER: LINE,
      ...extra,
    },
  });
  cleanups.push(() => {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  });
  const messages: ToParent[] = [];
  const waiters: { type: ToParent["type"]; resolve: (m: ToParent) => void }[] = [];
  child.on("message", (raw) => {
    const message = raw as ToParent;
    const waiter = waiters.findIndex((w) => w.type === message.type);
    if (waiter >= 0) waiters.splice(waiter, 1)[0]!.resolve(message);
    else messages.push(message);
  });
  const nextMessage = <T extends ToParent["type"]>(type: T, timeoutMs = 20_000) =>
    new Promise<Extract<ToParent, { type: T }>>((resolve, reject) => {
      const queued = messages.findIndex((m) => m.type === type);
      if (queued >= 0) return resolve(messages.splice(queued, 1)[0] as Extract<ToParent, { type: T }>);
      const timer = setTimeout(() => reject(new Error(`No ${type} message from the worker`)), timeoutMs);
      waiters.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m as Extract<ToParent, { type: T }>)) });
    });
  const ready = await nextMessage("ready");
  const send = (m: ToWorker) => child.send(m);
  return { child, ready, nextMessage, send };
}

describe("the touring process entry", () => {
  it("starts on loopback and reports its port", { timeout: 30_000 }, async () => {
    const w = await forkWorker();
    expect(w.ready.port).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${w.ready.port}/healthz`, { headers: { [WORKER_KEY_HEADER]: KEY } });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${w.ready.port}/healthz`)).status).toBe(404);
  });

  it("sends a test alert to the parent once alerts are connected", { timeout: 30_000 }, async () => {
    const w = await forkWorker();
    w.send({ type: "alerts", connected: true });
    const event = await w.nextMessage("event");
    expect(event.event.eventType).toBe("installation.test");
    w.send({ type: "event-ack", id: event.id, ok: true });
  });

  it("exits when the shared service goes away", { timeout: 30_000 }, async () => {
    const w = await forkWorker();
    const exited = new Promise<number | null>((resolve) => w.child.on("exit", resolve));
    w.child.disconnect();
    expect(await exited).not.toBeUndefined();
  });
});

describe("RelaySink", () => {
  const event = testEvent(new Date("2026-10-30T12:00:00Z"));

  it("resolves once the parent accepts the event", async () => {
    const sent: ToParent[] = [];
    const sink = new RelaySink((m) => void sent.push(m), () => true);
    const delivery = sink.deliver(event);
    const relayed = sent[0] as Extract<ToParent, { type: "event" }>;
    expect(relayed.event.eventId).toBe(event.eventId);
    sink.ack({ type: "event-ack", id: relayed.id, ok: true });
    await expect(delivery).resolves.toBeUndefined();
  });

  it("throws a retryable delivery error when the parent says to retry", async () => {
    const sent: ToParent[] = [];
    const sink = new RelaySink((m) => void sent.push(m), () => true);
    const delivery = sink.deliver(event);
    sink.ack({ type: "event-ack", id: (sent[0] as Extract<ToParent, { type: "event" }>).id, ok: false, retryable: true, message: "The routine is busy." });
    await expect(delivery).rejects.toMatchObject({ retryable: true, message: "The routine is busy." });
    await expect(delivery).rejects.toBeInstanceOf(DeliveryError);
  });

  it("gives up with a retryable error when no answer comes", async () => {
    const sink = new RelaySink(() => undefined, () => true, { timeoutMs: 20 });
    await expect(sink.deliver(event)).rejects.toMatchObject({ retryable: true });
  });

  it("is configured only while the parent says alerts are connected", () => {
    let connected = false;
    const sink = new RelaySink(() => undefined, () => connected);
    expect(sink.configured()).toBe(false);
    connected = true;
    expect(sink.configured()).toBe(true);
  });
});

describe("texting from a touring process", () => {
  function provider(env: NodeJS.ProcessEnv) {
    const calls: string[] = [];
    const client = {
      sendSms: async (input: { to: string }) => (calls.push(input.to), { sid: `SM${calls.length}`, status: "queued" }),
    } as unknown as TwilioClient;
    const full = { TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER", TOURCORE_TWILIO_ACCOUNT_SID: "ACx", TOURCORE_TWILIO_AUTH_TOKEN: "t", TOURCORE_TWILIO_PHONE_NUMBER: LINE, ...env };
    return { calls, twilio: new TwilioMessagingProvider({ env: () => readTwilioEnv(full), client }) };
  }
  const visitorText = { to: VISITOR, body: "Hi", audience: "VISITOR" as const };

  it("sends nothing while live texts are off", async () => {
    const p = provider({ CLEANER_CORE_LIVE_SMS: "0", CLEANER_CORE_SMS_ALLOWLIST: "*" });
    const receipt = await p.twilio.send(visitorText as never);
    expect(receipt.status).toBe("SUPPRESSED");
    expect(p.calls).toEqual([]);
  });

  it("sends nothing to a number off the allowlist", async () => {
    const p = provider({ CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: "+15555550100" });
    expect((await p.twilio.send(visitorText as never)).status).toBe("SUPPRESSED");
    expect(p.calls).toEqual([]);
  });

  it("sends to any visitor when live texts are on and the allowlist is *", async () => {
    const p = provider({ CLEANER_CORE_LIVE_SMS: "1", CLEANER_CORE_SMS_ALLOWLIST: "*" });
    expect((await p.twilio.send(visitorText as never)).status).not.toBe("SUPPRESSED");
    expect(p.calls).toEqual([VISITOR]);
  });

  it("leaves texting outside a touring process as it was", async () => {
    const p = provider({ TOURCORE_DEPLOYMENT_MODE: "LOCAL_DEVELOPER" });
    expect((await p.twilio.send(visitorText as never)).status).not.toBe("SUPPRESSED");
    expect(p.calls).toEqual([VISITOR]);
  });
});
