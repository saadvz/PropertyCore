import { describe, expect, it } from "vitest";
import { testEvent } from "../src/alerts/operatorEvents";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import type { ToParent, ToWorker } from "../src/hosted/ipc";
import { buildTouringEnv } from "../src/hosted/touringEnv";
import { TouringSupervisor, type SpawnWorker, type WorkerHandle } from "../src/hosted/touringSupervisor";

/** The supervisor with a fake fork and a clock the test moves. No process is started. */

const SECOND = 1000;
const lane: Tenant = { id: "tnt_lane000001", label: "Lane", twilioNumber: "+15555550150", connections: [], invites: [], service: "touring", createdAt: "2026-10-01T00:00:00.000Z" };
const court: Tenant = { ...lane, id: "tnt_court00001", label: "Court", twilioNumber: "+15555550160", service: "cleaning" };
const mill: Tenant = { ...lane, id: "tnt_mill000001", label: "Mill", twilioNumber: "+15555550170", disabled: true };

interface FakeWorker extends WorkerHandle {
  env: NodeJS.ProcessEnv;
  sent: ToWorker[];
  killed: boolean;
  emit(message: ToParent): void;
  exit(code?: number | null): void;
}

function harness() {
  let at = Date.parse("2026-10-30T12:00:00Z");
  const timers: { at: number; run: () => void }[] = [];
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const events: { tenantId: string; id: string }[] = [];
  const readies: string[] = [];
  const spawn: SpawnWorker = (env) => {
    let onMessage: (m: ToParent) => void = () => {};
    let onExit: (code: number | null) => void = () => {};
    const worker: FakeWorker = {
      env,
      sent: [],
      killed: false,
      send: (m) => void worker.sent.push(m),
      onMessage: (cb) => void (onMessage = cb),
      onExit: (cb) => void (onExit = cb),
      kill: () => void (worker.killed = true),
      emit: (m) => onMessage(m),
      exit: (code = 1) => onExit(code),
    };
    workers.push(worker);
    return worker;
  };
  const supervisor = new TouringSupervisor({
    spawn,
    env: (tenant, key) => ({ TENANT: tenant.id, KEY: key }),
    onEvent: async (tenantId, id) => (events.push({ tenantId, id }), { type: "event-ack", id, ok: true }),
    log: (line) => void logs.push(line),
    onReady: (tenantId) => void readies.push(tenantId),
    now: () => at,
    setTimer: (run, ms) => (timers.push({ at: at + ms, run }), { unref() {} }) as never,
  });
  /** Moves the clock, running each timer that comes due, in order. */
  const advance = (ms: number) => {
    const end = at + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      at = next.at;
      next.run();
    }
    at = end;
  };
  const startReady = async (tenant: Tenant) => {
    const started = supervisor.ensure(tenant);
    workers.at(-1)!.emit({ type: "ready", port: 40000 + workers.length });
    await started;
  };
  return { supervisor, workers, logs, events, readies, advance, startReady, now: () => at };
}

describe("buildTouringEnv", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    TOURCORE_HOME: "/elsewhere",
    TOURCORE_STORAGE_MODEL: "DIRECT_GOOGLE_DRIVE",
    TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
    CLEANER_CORE_ROUTINE_KEY: "another-tenants-routine-key",
    CLEANER_CORE_PIN_KEY: "another-tenants-pin-key",
    CLEANER_CORE_ADMIN_PASSWORD: "admin-password",
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACshared",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "shared-auth",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_SMS_ALLOWLIST: "*",
  };
  const env = buildTouringEnv({ base, tenant: lane, dataRoot: "/data", origin: "https://s.up.railway.app/", key: "k1", scratch: false });

  it("gives a worker only its own tenant's values", () => {
    expect(env.CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
    expect(env.CLEANER_CORE_PIN_KEY).toBeUndefined();
    expect(env.CLEANER_CORE_ADMIN_PASSWORD).toBeUndefined();
    expect(env.TOURCORE_STORAGE_MODEL).toBeUndefined();
    expect(env.TOURCORE_HOME).toBe(`/data/tenants/${lane.id}/tour-core`);
    expect(env.TOURCORE_DEPLOYMENT_MODE).toBe("TENANT_WORKER");
    expect(env.TOURCORE_WORKER_KEY).toBe("k1");
    expect(env.PUBLIC_BASE_URL).toBe(`https://s.up.railway.app/t/${lane.id}`);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("texts on the tenant's number through the shared Twilio account, under the live switch", () => {
    expect(env.TOURCORE_MESSAGING_PROVIDER).toBe("twilio");
    expect(env.TOURCORE_TWILIO_PHONE_NUMBER).toBe(lane.twilioNumber);
    expect(env.TOURCORE_TWILIO_ACCOUNT_SID).toBe("ACshared");
    expect(env.TOURCORE_TWILIO_AUTH_TOKEN).toBe("shared-auth");
    expect(env.CLEANER_CORE_TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(env.CLEANER_CORE_LIVE_SMS).toBe("1");
    expect(env.CLEANER_CORE_SMS_ALLOWLIST).toBe("*");
  });

  it("uses local test texts for a Scratch tenant, with no Twilio account", () => {
    const scratch = buildTouringEnv({ base, tenant: lane, dataRoot: "/data", origin: "https://s.up.railway.app", key: "k1", scratch: true });
    expect(scratch.TOURCORE_MESSAGING_PROVIDER).toBe("local");
    expect(scratch.TOURCORE_TOURING_SCRATCH).toBe("1");
    expect(scratch.TOURCORE_TWILIO_AUTH_TOKEN).toBeUndefined();
  });
});

describe("TouringSupervisor", () => {
  it("starts a worker with a fresh key and reports where it listens once ready", async () => {
    const h = harness();
    const started = h.supervisor.ensure(lane);
    expect(h.supervisor.target(lane.id)).toBeUndefined();
    h.workers[0]!.emit({ type: "ready", port: 40123 });
    await started;
    const target = h.supervisor.target(lane.id)!;
    expect(target.port).toBe(40123);
    expect(target.key).toBe(h.workers[0]!.env.KEY);
    expect(target.key.length).toBeGreaterThanOrEqual(43);
  });

  it("starts each tenant once", async () => {
    const h = harness();
    await h.startReady(lane);
    await h.supervisor.ensure(lane);
    expect(h.workers).toHaveLength(1);
  });

  it("restarts after a crash with a growing delay, and a new key", async () => {
    const h = harness();
    await h.startReady(lane);
    const spawnedAt: number[] = [];
    const firstKey = h.supervisor.target(lane.id)!.key;
    for (let crash = 0; crash < 3; crash++) {
      const count = h.workers.length;
      h.workers.at(-1)!.exit(1);
      expect(h.supervisor.target(lane.id)).toBeUndefined();
      while (h.workers.length === count) h.advance(SECOND);
      spawnedAt.push(h.now());
    }
    const t0 = Date.parse("2026-10-30T12:00:00Z");
    expect(spawnedAt.map((t) => (t - t0) / SECOND)).toEqual([1, 3, 7]);
    h.workers.at(-1)!.emit({ type: "ready", port: 40999 });
    expect(h.supervisor.target(lane.id)!.key).not.toBe(firstKey);
    expect(h.supervisor.health(lane.id)).toEqual({ up: true, restartsLastDay: 3 });
  });

  it("tells the service each time a worker is ready, a restart included, so waiting texts go out", async () => {
    const h = harness();
    await h.startReady(lane);
    h.workers[0]!.exit(1);
    h.advance(SECOND);
    h.workers[1]!.emit({ type: "ready", port: 40002 });
    expect(h.readies).toEqual([lane.id, lane.id]);
  });

  it("never waits more than a minute between restarts", async () => {
    const h = harness();
    await h.startReady(lane);
    for (let crash = 0; crash < 10; crash++) {
      const count = h.workers.length;
      h.workers.at(-1)!.exit(1);
      while (h.workers.length === count) h.advance(SECOND);
    }
    const count = h.workers.length;
    h.workers.at(-1)!.exit(1);
    h.advance(60 * SECOND);
    expect(h.workers.length).toBe(count + 1);
  });

  it("never restarts a stopped tenant, and drops its late messages", async () => {
    const h = harness();
    await h.startReady(lane);
    const old = h.workers[0]!;
    h.supervisor.stop(lane.id);
    expect(old.killed).toBe(true);
    old.emit({ type: "event", id: "e1", event: testEvent(new Date()) });
    old.exit(0);
    h.advance(120 * SECOND);
    expect(h.workers).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(h.supervisor.target(lane.id)).toBeUndefined();
    expect(h.supervisor.health(lane.id)).toEqual({ up: false, restartsLastDay: 0 });
  });

  it("relays a worker's alert and sends the answer back", async () => {
    const h = harness();
    await h.startReady(lane);
    h.workers[0]!.emit({ type: "event", id: "e1", event: testEvent(new Date()) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.events).toEqual([{ tenantId: lane.id, id: "e1" }]);
    expect(h.workers[0]!.sent).toContainEqual({ type: "event-ack", id: "e1", ok: true });
  });

  it("tells a worker whether alerts are connected, again after a restart", async () => {
    const h = harness();
    await h.startReady(lane);
    h.supervisor.setAlerts(lane.id, true);
    expect(h.workers[0]!.sent).toContainEqual({ type: "alerts", connected: true });
    h.workers[0]!.exit(1);
    h.advance(SECOND);
    h.workers[1]!.emit({ type: "ready", port: 40002 });
    expect(h.workers[1]!.sent).toContainEqual({ type: "alerts", connected: true });
  });

  it("prefixes a worker's log lines with its tenant", async () => {
    const h = harness();
    await h.startReady(lane);
    h.workers[0]!.emit({ type: "log", line: "Picked up 1 text-message tour." });
    expect(h.logs).toContain(`[${lane.id}] Picked up 1 text-message tour.`);
  });

  it("starts touring tenants and stops the rest on sync", async () => {
    const h = harness();
    await h.startReady(court.service === "cleaning" ? { ...court, service: "touring" } : court);
    const sync = h.supervisor.syncAll([lane, court, mill]);
    for (const worker of h.workers.slice(1)) worker.emit({ type: "ready", port: 41000 });
    await sync;
    expect(h.workers[0]!.killed).toBe(true);
    expect(h.workers.filter((w) => !w.killed).map((w) => w.env.TENANT)).toEqual([lane.id]);
  });
});
