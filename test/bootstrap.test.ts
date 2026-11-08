import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeVersionProblem, runBootstrap } from "../src/install/bootstrap";
import { publicHealth } from "../src/install/checks";
import type { ProcessControl } from "../src/install/processes";
import { CloudflareQuickTunnelProvider, ManualPublicEndpointProvider } from "../src/install/publicEndpoint";
import { readRuntimeInfo, ServiceManager, serviceDir, writeRuntimeInfo } from "../src/install/service";
import { installHarness } from "./installHarness";

/**
 * The install layer without real processes or network: a fake process table
 * (Tour Core's server and cloudflared), a fake local health page, and the
 * real bootstrap, service manager, tunnel provider and installation files.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const TUNNELS = ["https://brave-otter-lamp.trycloudflare.com", "https://quiet-heron-glass.trycloudflare.com"];

function world(options: { cloudflared?: boolean; tunnelPrintsUrl?: boolean } = {}) {
  const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
  cleanups.push(h.cleanup);
  const alive = new Set<number>();
  const servers = new Map<number, number>(); // port -> pid
  const spawned: Array<{ command: string; args: string[]; pid: number }> = [];
  let nextPid = 4000;
  let tunnelCount = 0;
  const processes: ProcessControl = {
    spawnDetached(command, args, opts) {
      const pid = ++nextPid;
      alive.add(pid);
      spawned.push({ command, args, pid });
      if (args.includes("tunnel")) {
        if (options.tunnelPrintsUrl !== false) appendFileSync(opts.logFile, `INF Requesting new quick Tunnel\nINF |  ${TUNNELS[tunnelCount++ % TUNNELS.length]}  |\n`);
      } else {
        // Tour Core's server: listening and recording where it is, like src/web/server.ts does.
        const port = Number(args.find((a) => a.startsWith("--port="))!.split("=")[1]);
        servers.set(port, pid);
        writeRuntimeInfo(h.root, { pid, port, url: `http://localhost:${port}`, startedAt: new Date().toISOString() });
      }
      return pid;
    },
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      alive.delete(pid);
      for (const [port, p] of servers) if (p === pid) servers.delete(port);
    },
    which: (cmd) => (cmd === "cloudflared" && options.cloudflared !== false ? "/usr/local/bin/cloudflared" : undefined),
  };
  const localFetch = async (url: string) => {
    const port = Number(new URL(url).port);
    const pid = servers.get(port);
    if (!pid || !alive.has(pid)) throw new Error("ECONNREFUSED");
    return { status: 200, json: async () => ({ ok: true, service: "tour-core", pid }) };
  };
  const service = new ServiceManager({ root: h.root, repoDir: "/opt/tour-core", port: 4321, processes, fetch: localFetch, nodePath: "node", startTimeoutMs: 2000 });
  const tunnel = new CloudflareQuickTunnelProvider({ serviceDir: serviceDir(h.root), binDir: join(h.root, "bin"), processes, waitMs: 1000 });
  h.net.state.health = () => publicHealth(h.inst);
  const bootstrap = () =>
    runBootstrap(
      { installation: h.inst, workspace: h.workspace, service, endpoint: tunnel, dependencies: () => ({ ok: true, message: "deps ok" }), endpointCheck: { attempts: 1, delayMs: 0 } },
      { mode: "GROK_MANAGED_P0", legacyOAuthCompat: true },
    );
  const serverPids = () => spawned.filter((s) => !s.args.includes("tunnel")).map((s) => s.pid);
  const tunnelPids = () => spawned.filter((s) => s.args.includes("tunnel")).map((s) => s.pid);
  return { h, service, tunnel, processes, spawned, alive, bootstrap, serverPids, tunnelPids };
}

describe("service manager", () => {
  it("starts Tour Core once, reports it healthy, and leaves a healthy one alone", async () => {
    const w = world();
    expect(await w.service.status()).toMatchObject({ running: false, healthy: false, message: "Tour Core isn't running." });
    const started = await w.service.start();
    expect(started).toMatchObject({ started: true, healthy: true, localUrl: "http://localhost:4321" });
    expect(w.spawned[0]!.args).toEqual(["--import", "tsx", join("src", "web", "server.ts"), "--no-open", "--port=4321"]);
    expect(await w.service.start()).toMatchObject({ started: false, healthy: true });
    expect(w.serverPids()).toHaveLength(1);
  });

  it("detects a stopped runtime and starts it again; stop and restart work", async () => {
    const w = world();
    const first = await w.service.start();
    w.processes.kill(first.pid!);
    expect(await w.service.status()).toMatchObject({ running: false, message: "Tour Core stopped." });
    const again = await w.service.start();
    expect(again).toMatchObject({ started: true, healthy: true });
    expect(again.pid).not.toBe(first.pid);
    const restarted = await w.service.restart();
    expect(restarted.healthy).toBe(true);
    expect(w.alive.has(again.pid!)).toBe(false);
    expect(await w.service.stop()).toEqual({ stopped: true, message: "Tour Core stopped. Its records are saved." });
    expect(readRuntimeInfo(w.h.root)).toBeUndefined();
    expect(await w.service.stop()).toMatchObject({ stopped: false, message: "Tour Core wasn't running." });
  });
});

describe("public endpoint providers", () => {
  it("quick tunnel: starts cloudflared, captures the https address, and reuses a running tunnel", async () => {
    const w = world();
    const first = await w.tunnel.ensure("http://127.0.0.1:4321");
    expect(first).toEqual({ state: "READY", provider: "CLOUDFLARE_QUICK_TUNNEL", url: TUNNELS[0], message: "Started a public tunnel." });
    expect(w.spawned[0]).toMatchObject({ command: "/usr/local/bin/cloudflared", args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"] });
    expect(await w.tunnel.ensure("http://127.0.0.1:4321")).toMatchObject({ state: "READY", url: TUNNELS[0], message: "The public tunnel is running." });
    expect(w.tunnelPids()).toHaveLength(1);
    // The tunnel died: a new one has a new address.
    w.processes.kill(w.tunnelPids()[0]!);
    expect(await w.tunnel.ensure("http://127.0.0.1:4321")).toMatchObject({ state: "READY", url: TUNNELS[1] });
  });

  it("returns one clear step when cloudflared isn't available and can't be downloaded safely", async () => {
    const w = world({ cloudflared: false });
    const mac = new CloudflareQuickTunnelProvider({ serviceDir: serviceDir(w.h.root), binDir: join(w.h.root, "bin"), processes: w.processes, platform: "darwin", arch: "arm64" });
    const result = await mac.ensure("http://127.0.0.1:4321");
    expect(result.state).toBe("ACTION_REQUIRED");
    expect(result.message).toMatch(/^cloudflared isn't installed on this computer\. Install it \(https:\/\/developers\.cloudflare\.com\/.+\), or set PUBLIC_BASE_URL/);
    expect(w.spawned).toHaveLength(0);
  });

  it("on Linux, downloads the official cloudflared binary into the data folder and uses it", async () => {
    const w = world({ cloudflared: false });
    const downloads: string[] = [];
    const linux = new CloudflareQuickTunnelProvider({
      serviceDir: serviceDir(w.h.root),
      binDir: join(w.h.root, "bin"),
      processes: w.processes,
      platform: "linux",
      arch: "x64",
      waitMs: 1000,
      download: async (url, dest) => {
        downloads.push(url);
        writeFileSync(dest, "binary");
      },
    });
    expect((await linux.ensure("http://127.0.0.1:4321")).state).toBe("READY");
    expect(downloads).toEqual(["https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"]);
    expect(w.spawned[0]!.command).toBe(join(w.h.root, "bin", "cloudflared"));
  });

  it("reports an error, not a guess, when cloudflared never prints an address", async () => {
    const w = world({ tunnelPrintsUrl: false });
    const r = await w.tunnel.ensure("http://127.0.0.1:4321");
    expect(r).toMatchObject({ state: "ERROR", message: "cloudflared didn't report a public address in time. Run the bootstrap again." });
    expect(w.alive.size).toBe(0);
  });

  it("manual provider: an https address is used as-is; anything else is one clear step", async () => {
    expect(await new ManualPublicEndpointProvider(() => "https://tours.example.org/").ensure()).toMatchObject({ state: "READY", url: "https://tours.example.org" });
    expect(await new ManualPublicEndpointProvider(() => "http://tours.example.org").ensure()).toMatchObject({ state: "ACTION_REQUIRED", message: "The configured public address isn't an https address. Set PUBLIC_BASE_URL to https://..." });
  });
});

describe("bootstrap:grok", () => {
  it("installs, starts, opens a public address, checks it, and prints operator-safe status", async () => {
    const w = world();
    const report = await w.bootstrap();
    expect(report.ok).toBe(true);
    expect(report.createdInstallation).toBe(true);
    expect(report.steps.map((s) => [s.step, s.ok])).toEqual([
      ["detect", true],
      ["dependencies", true],
      ["folders", true],
      ["manifest", true],
      ["configuration", true],
      ["oauth-compatibility", true],
      ["runtime", true],
      ["public-address", true],
      ["public-address-check", true],
      ["secure-setup", true],
    ]);
    expect(report).toMatchObject({ localUrl: "http://localhost:4321", publicAddress: TUNNELS[0], connectorUrl: `${TUNNELS[0]}/mcp`, publicAddressChanged: false });
    expect(report.secureSetupUrl).toMatch(/^http:\/\/localhost:4321\/install#s=[A-Za-z0-9_-]{32}$/);
    expect(w.h.inst.files.manifest()).toMatchObject({ deploymentMode: "GROK_MANAGED_P0", publicBaseUrl: TUNNELS[0], publicEndpointProvider: "CLOUDFLARE_QUICK_TUNNEL", options: { grokLegacyOAuthCompat: true } });
    expect(report.status.nextStep).toMatchObject({ component: "GROK_OPERATOR", action: "CONNECT_GROK", performedBy: "OPERATOR" });
    expect(existsSync(join(w.h.root, "install"))).toBe(true);
  });

  it("is idempotent: a second run repairs/checks the same installation instead of creating another", async () => {
    const w = world();
    const first = await w.bootstrap();
    const second = await w.bootstrap();
    expect(second.installationId).toBe(first.installationId);
    expect(second.createdInstallation).toBe(false);
    expect(second.steps.find((s) => s.step === "detect")!.message).toBe(`Found installation ${first.installationId} (Grok's cloud computer (demo)).`);
    expect(second.steps.find((s) => s.step === "runtime")!.message).toBe("Tour Core is already running at http://localhost:4321.");
    expect(second.publicAddress).toBe(first.publicAddress);
    expect(second.publicAddressChanged).toBe(false);
    expect(w.serverPids()).toHaveLength(1);
    expect(w.tunnelPids()).toHaveLength(1);
  });

  it("restarts a stopped runtime, and flags a changed tunnel address instead of silently using it", async () => {
    const w = world();
    await w.bootstrap();
    w.h.connectGrok();
    expect((await w.bootstrap()).status.components.find((c) => c.component === "GROK_OPERATOR")!.state).toBe("READY");
    // Grok's computer stopped both processes.
    for (const pid of [...w.alive]) w.processes.kill(pid);
    const repaired = await w.bootstrap();
    expect(repaired.steps.find((s) => s.step === "runtime")).toMatchObject({ ok: true, message: "Started Tour Core at http://localhost:4321." });
    expect(repaired.publicAddress).toBe(TUNNELS[1]);
    expect(repaired.publicAddressChanged).toBe(true);
    const grok = repaired.status.components.find((c) => c.component === "GROK_OPERATOR")!;
    expect(grok).toMatchObject({ state: "ACTION_REQUIRED", next: { action: "RECONNECT_GROK" } });
    expect(repaired.status.nextStep.action).toBe("RECONNECT_GROK");
  });

  it("refuses to start a clone of an unexpected repository", async () => {
    const w = world();
    const report = await runBootstrap(
      {
        installation: w.h.inst,
        workspace: w.h.workspace,
        service: w.service,
        endpoint: w.tunnel,
        dependencies: () => ({ ok: true, message: "deps ok" }),
        repository: () => ({ ok: false, message: "Not starting an unexpected repository." }),
      },
      { mode: "GROK_MANAGED_P0" },
    );
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => s.step)).toEqual(["detect", "repository"]);
    expect(w.spawned).toHaveLength(0);
    expect(w.h.inst.files.manifest()).toBeUndefined();
  });

  it("stops at dependencies with a clear message when they're missing", async () => {
    const w = world();
    const report = await runBootstrap(
      { installation: w.h.inst, workspace: w.h.workspace, service: w.service, endpoint: w.tunnel, dependencies: () => ({ ok: false, message: "Dependencies aren't installed (missing tsx)." }) },
      { mode: "GROK_MANAGED_P0" },
    );
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toEqual({ step: "dependencies", ok: false, message: "Dependencies aren't installed (missing tsx)." });
    expect(report.status.nextStep).toMatchObject({ component: "RUNTIME", action: "START_RUNTIME", command: "npm run bootstrap:grok" });
    expect(w.spawned).toHaveLength(0);
  });
});

describe("Node.js version check", () => {
  const TOO_OLD = /^Tour Core needs Node\.js 22\.13 or newer \(this computer has [0-9.]+\)\.$/;

  it("requires Node.js 22.13, which package.json engines and ci-check.sh need", () => {
    expect(nodeVersionProblem("20.11.0")).toMatch(TOO_OLD);
    expect(nodeVersionProblem("22.12.0")).toBe("Tour Core needs Node.js 22.13 or newer (this computer has 22.12.0).");
    expect(nodeVersionProblem("22.13.0")).toBeUndefined();
    expect(nodeVersionProblem("23.0.0")).toBeUndefined();
  });

  it("bootstrap:grok stops on an older Node.js with the same message, before installing anything", () => {
    for (const version of ["20.11.0", "22.12.0"]) {
      // Pretend to be an older Node, and never let the script run npm or the real bootstrap.
      const fake = [
        `Object.defineProperty(process.versions, "node", { value: "${version}" });`,
        `const cp = await import("node:child_process"); const { syncBuiltinESMExports } = await import("node:module");`,
        `cp.default.spawnSync = () => ({ status: 99 }); syncBuiltinESMExports();`,
      ].join(" ");
      const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(fake)}`, join("scripts", "bootstrap-grok.mjs")], { encoding: "utf8" });
      expect(run.status, version).toBe(1);
      expect(run.stderr.trim()).toBe(`Tour Core needs Node.js 22.13 or newer (this computer has ${version}).`);
      expect(run.stdout).toBe("");
    }
  });
});
