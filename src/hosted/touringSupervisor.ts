import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { OperatorEvent } from "../alerts/operatorEvents";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { ToParent, ToWorker } from "./ipc";

/**
 * Runs one Tour Core process per touring tenant: starts it, restarts it after a crash with a growing
 * delay, and stops it when the tenant switches away, is turned off, or is deleted. Each start gets a
 * fresh key, and only the running process's messages count; a stopped one's late messages are dropped.
 */

export interface WorkerHandle {
  send(message: ToWorker): void;
  onMessage(cb: (message: ToParent) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnWorker = (env: NodeJS.ProcessEnv) => WorkerHandle;

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
/** Up this long, and the next crash starts the delays over. */
const STEADY_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Forks the touring process: dist/touringWorker.js next to the built server, or the source file under tsx. */
export const forkTouringWorker: SpawnWorker = (env) => {
  const built = fileURLToPath(new URL("./touringWorker.js", import.meta.url));
  const source = fileURLToPath(new URL("./touringWorker.ts", import.meta.url));
  const child = existsSync(built)
    ? fork(built, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    : fork(source, [], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const lines: ((line: string) => void)[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) createInterface({ input: stream }).on("line", (line) => lines.forEach((cb) => cb(line)));
  }
  return {
    send: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (cb) => {
      child.on("message", (raw) => cb(raw as ToParent));
      lines.push((line) => cb({ type: "log", line: line.trim() }));
    },
    onExit: (cb) => void child.on("exit", (code) => cb(code)),
    kill: () => void child.kill(),
  };
};

interface Running {
  tenant: Tenant;
  key: string;
  handle?: WorkerHandle;
  port?: number;
  startedAt: number;
  failures: number;
  restarts: number[];
  alerts: boolean;
  retry?: { unref?(): void };
  waiting: (() => void)[];
}

export class TouringSupervisor {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly opts: {
      spawn: SpawnWorker;
      env: (tenant: Tenant, key: string) => NodeJS.ProcessEnv;
      onEvent: (tenantId: string, id: string, event: OperatorEvent) => Promise<ToWorker>;
      log: (line: string) => void;
      /** A process for the tenant is ready, after a start or a restart: texts that waited can go out. */
      onReady?: (tenantId: string) => void;
      now: () => number;
      setTimer?: (run: () => void, ms: number) => { unref?(): void };
    },
  ) {}

  /** Starts the tenant's process when none runs. Resolves once a process for it is ready. */
  ensure(tenant: Tenant): Promise<void> {
    const current = this.running.get(tenant.id);
    if (current) {
      current.tenant = tenant;
      return current.port !== undefined ? Promise.resolve() : new Promise((resolve) => current.waiting.push(resolve));
    }
    const entry: Running = { tenant, key: "", startedAt: 0, failures: 0, restarts: [], alerts: false, waiting: [] };
    this.running.set(tenant.id, entry);
    const ready = new Promise<void>((resolve) => entry.waiting.push(resolve));
    this.start(entry);
    return ready;
  }

  /** Kills the tenant's process and forgets it. No restart follows. */
  stop(tenantId: string): void {
    const entry = this.running.get(tenantId);
    if (!entry) return;
    this.running.delete(tenantId);
    entry.handle?.kill();
    entry.handle = undefined;
    entry.port = undefined;
  }

  /** Stops every process. The service is shutting down. */
  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  /** Where the tenant's process listens and its key. Undefined while starting, down, or stopped. */
  target(tenantId: string): { port: number; key: string } | undefined {
    const entry = this.running.get(tenantId);
    return entry?.handle && entry.port !== undefined ? { port: entry.port, key: entry.key } : undefined;
  }

  /** Whether the tenant's touring alert routine is connected. Sent now, and again after every restart. */
  setAlerts(tenantId: string, connected: boolean): void {
    const entry = this.running.get(tenantId);
    if (!entry) return;
    entry.alerts = connected;
    if (entry.port !== undefined) entry.handle?.send({ type: "alerts", connected });
  }

  health(tenantId: string): { up: boolean; restartsLastDay: number } {
    const entry = this.running.get(tenantId);
    const since = this.opts.now() - DAY_MS;
    return { up: !!this.target(tenantId), restartsLastDay: entry ? entry.restarts.filter((at) => at > since).length : 0 };
  }

  /** Runs every enabled touring tenant and stops every other. */
  async syncAll(tenants: Tenant[]): Promise<void> {
    const touring = tenants.filter((t) => t.service === "touring" && !t.disabled);
    const keep = new Set(touring.map((t) => t.id));
    for (const id of [...this.running.keys()]) if (!keep.has(id)) this.stop(id);
    await Promise.all(touring.map((tenant) => this.ensure(tenant)));
  }

  private start(entry: Running): void {
    const id = entry.tenant.id;
    entry.key = randomBytes(32).toString("base64url");
    entry.port = undefined;
    entry.startedAt = this.opts.now();
    const handle = this.opts.spawn(this.opts.env(entry.tenant, entry.key));
    entry.handle = handle;
    // A message or exit from a process that has since been replaced or stopped changes nothing.
    const current = () => this.running.get(id) === entry && entry.handle === handle;
    handle.onMessage((message) => {
      if (!current()) return;
      if (message.type === "ready") {
        entry.port = message.port;
        if (entry.alerts) handle.send({ type: "alerts", connected: true });
        for (const resolve of entry.waiting.splice(0)) resolve();
        this.opts.onReady?.(id);
      } else if (message.type === "log") {
        this.opts.log(`[${id}] ${message.line}`);
      } else if (message.type === "event") {
        void this.opts
          .onEvent(id, message.id, message.event)
          .catch((): ToWorker => ({ type: "event-ack", id: message.id, ok: false, retryable: true, message: "The shared service couldn't deliver this update." }))
          .then((answer) => {
            if (current()) handle.send(answer);
          });
      }
    });
    handle.onExit((code) => {
      if (!current()) return;
      entry.handle = undefined;
      entry.port = undefined;
      const now = this.opts.now();
      entry.failures = now - entry.startedAt >= STEADY_MS ? 1 : entry.failures + 1;
      entry.restarts.push(now);
      const delay = Math.min(FIRST_DELAY_MS * 2 ** (entry.failures - 1), MAX_DELAY_MS);
      this.opts.log(`[${id}] The touring process stopped (code ${code ?? "none"}). Restarting in ${Math.round(delay / 1000)}s.`);
      const timer = (this.opts.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
        if (this.running.get(id) === entry && !entry.handle) this.start(entry);
      }, delay);
      timer.unref?.();
      entry.retry = timer;
    });
  }
}
