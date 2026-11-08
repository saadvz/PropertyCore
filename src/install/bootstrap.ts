import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mcpAuthModeFromEnv } from "../mcp/authMode";
import { defaultWorkspaceRoot, PropertyWorkspace } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { loadLocalEnv } from "../web/env";
import { checkPublicEndpoint } from "./checks";
import { DEPLOYMENT_MODE_LABELS, parseDeploymentMode, type DeploymentMode } from "./deployment";
import { Installation } from "./installation";
import { canonicalRepoUrl, checkRepositorySource, originUrl } from "./repoSource";
import { CloudflareQuickTunnelProvider, downloadFile, ManualPublicEndpointProvider, RailwayPublicEndpointProvider, type PublicEndpointProvider } from "./publicEndpoint";
import { ServiceManager, serviceDir, type ServiceStatus } from "./service";
import { useSettingsSource } from "./settings";
import { getInstallationStatus, type InstallationStatus } from "./status";

/**
 * One canonical, idempotent bootstrap for a Tour Core installation, designed
 * for Grok's cloud computer (`npm run bootstrap:grok`):
 *
 *   detect → dependencies → folders → manifest → configuration → start the
 *   runtime → local health → public address → outside check → status
 *
 * Running it again checks and repairs the same installation: the manifest's
 * installation id is kept, a healthy runtime is left alone, a stopped one is
 * started, and a running tunnel is reused. Output is operator-safe: no
 * credential is ever printed.
 */

export const REQUIRED_MODULES = ["tsx", "@modelcontextprotocol/sdk", "express", "sendblue", "spectrum-ts", "zod"];

/**
 * Why this Node.js can't run Tour Core, or undefined when it can. 22.13 matches
 * package.json engines and scripts/ci-check.sh (node:sqlite, process.loadEnvFile).
 * scripts/bootstrap-grok.mjs repeats this check before dependencies exist.
 */
export function nodeVersionProblem(version: string): string | undefined {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return `Tour Core needs Node.js 22.13 or newer (this computer has ${version}).`;
  return undefined;
}

export function checkDependencies(repoDir: string): { ok: boolean; message: string } {
  const problem = nodeVersionProblem(process.versions.node);
  if (problem) return { ok: false, message: problem };
  const missing = REQUIRED_MODULES.filter((m) => !existsSync(join(repoDir, "node_modules", ...m.split("/"))));
  if (missing.length) return { ok: false, message: `Dependencies aren't installed (missing ${missing.join(", ")}). Run npm ci in the Tour Core folder.` };
  return { ok: true, message: `Node.js ${process.versions.node}; dependencies installed.` };
}

export interface BootstrapOptions {
  mode: DeploymentMode;
  /** P0: accept Grok's current legacy OAuth callback. */
  legacyOAuthCompat?: boolean;
}

export interface BootstrapDeps {
  installation: Installation;
  workspace: PropertyWorkspace;
  service: Pick<ServiceManager, "status" | "start">;
  endpoint: PublicEndpointProvider | undefined;
  dependencies: () => { ok: boolean; message: string };
  /** Whether this clone is the canonical repository (or no canonical one is recorded). */
  repository?: () => { ok: boolean; message: string };
  endpointCheck?: { attempts: number; delayMs: number };
  now?: () => Date;
}

export interface BootstrapStep {
  step: string;
  ok: boolean;
  message: string;
}

export interface BootstrapReport {
  ok: boolean;
  installationId?: string;
  createdInstallation: boolean;
  deploymentMode: DeploymentMode;
  localUrl?: string;
  publicAddress?: string;
  publicAddressChanged: boolean;
  connectorUrl?: string;
  secureSetupUrl?: string;
  /** What Grok should tell the operator, in plain words. */
  operatorMessage: string;
  steps: BootstrapStep[];
  status: InstallationStatus;
}

export async function runBootstrap(deps: BootstrapDeps, options: BootstrapOptions): Promise<BootstrapReport> {
  const inst = deps.installation;
  const now = () => deps.now?.() ?? new Date(inst.now());
  const steps: BootstrapStep[] = [];
  const add = (step: string, ok: boolean, message: string) => steps.push({ step, ok, message });
  const finish = (runtime: ServiceStatus | undefined, extra: Partial<BootstrapReport> = {}): BootstrapReport => {
    const manifest = inst.files.manifest();
    const status = getInstallationStatus(inst, { workspace: deps.workspace, runtime: inst.runtime }, { runtime: { running: !!runtime?.healthy, message: runtime?.message } });
    const blocked = steps.find((s) => !s.ok && ["repository", "dependencies", "runtime"].includes(s.step));
    return {
      ok: !!runtime?.healthy,
      ...(manifest ? { installationId: manifest.installationId } : {}),
      createdInstallation: false,
      deploymentMode: options.mode,
      publicAddressChanged: false,
      operatorMessage: blocked ? "I ran into a problem installing Tour Core on my cloud computer. I'm looking into it." : status.nextStep.operatorMessage,
      ...(status.technical.publicAddress ? { publicAddress: status.technical.publicAddress, connectorUrl: status.technical.connectorUrl } : {}),
      steps,
      status,
      ...extra,
    };
  };

  // 1. What's already here.
  const before = inst.files.readableManifest();
  add("detect", true, before ? `Found installation ${before.installationId} (${DEPLOYMENT_MODE_LABELS[before.deploymentMode]}).` : "No Tour Core installation here yet; creating one.");

  // Never start an unexpected repository.
  if (deps.repository) {
    const repo = deps.repository();
    add("repository", repo.ok, repo.message);
    if (!repo.ok) return finish(undefined);
  }

  // 2. Dependencies (the launcher installs them when missing).
  const dependencies = deps.dependencies();
  add("dependencies", dependencies.ok, dependencies.message);
  if (!dependencies.ok) return finish(undefined);

  // 3. Runtime folders.
  for (const dir of [inst.files.paths.dir, join(inst.root, "runtime"), serviceDir(inst.root)]) mkdirSync(dir, { recursive: true });
  add("folders", true, `Tour Core data folder: ${inst.root}`);

  // 4. Manifest (the installation id is created once and kept).
  const { manifest, created } = inst.files.ensure({ deploymentMode: options.mode, now: now(), ...(options.legacyOAuthCompat !== undefined ? { options: { grokLegacyOAuthCompat: options.legacyOAuthCompat } } : {}) });
  add("manifest", true, created ? `Created installation ${manifest.installationId}.` : `Using installation ${manifest.installationId}.`);

  // 5. Configuration that would stop Grok from connecting.
  const env = inst.env();
  const auth = mcpAuthModeFromEnv(env);
  const deployment = inst.deployment();
  const problems = [
    ...(deployment.invalid ? [`TOURCORE_DEPLOYMENT_MODE "${deployment.invalid}" isn't recognized.`] : []),
    ...(typeof auth !== "string" ? [`TOURCORE_MCP_AUTH_MODE "${auth.invalid}" turns the Grok connector off; remove it.`] : []),
    ...(auth === "static" && options.mode !== "LOCAL_DEVELOPER" ? ["TOURCORE_MCP_AUTH_MODE=static is for development only; remove it so Grok connects with OAuth."] : []),
  ];
  add("configuration", problems.length === 0, problems.length ? problems.join(" ") : "Configuration looks right.");
  if (manifest.options?.grokLegacyOAuthCompat) add("oauth-compatibility", true, "Grok legacy OAuth compatibility is on for this P0 demo (Grok's current callback needs it). Turn it off with --strict-oauth once Grok no longer requires it.");

  // 6-7. Start the runtime (or keep the healthy one) and check local health.
  const runtime = await deps.service.start();
  add("runtime", runtime.healthy, runtime.healthy ? (runtime.started ? `Started Tour Core at ${runtime.localUrl}.` : `Tour Core is already running at ${runtime.localUrl}.`) : runtime.message);
  if (!runtime.healthy || !runtime.localUrl) return finish(runtime, { createdInstallation: created });

  // 8. Public https address.
  let publicAddressChanged = false;
  if (deps.endpoint) {
    const result = await deps.endpoint.ensure(runtime.localUrl.replace("localhost", "127.0.0.1"));
    if (result.state === "READY" && result.url) {
      const change = inst.files.setPublicBaseUrl(result.url, deps.endpoint.kind, now());
      publicAddressChanged = change.changed;
      add(
        "public-address",
        true,
        change.changed
          ? `Public address changed to ${result.url}. Grok must reconnect, and visitor messaging needs the new address; the installation status says what to do.`
          : `Public address: ${result.url}`,
      );
      const check = await checkPublicEndpoint(inst, deps.endpointCheck ?? { attempts: 10, delayMs: 3000 });
      add("public-address-check", check.ok, check.message);
    } else add("public-address", false, result.message);
  } else add("public-address", true, "No public address needed for local development (set PUBLIC_BASE_URL to use real phones or Grok).");

  // 9. A short-lived secure setup link for credential steps.
  const { token } = inst.sessions.mint();
  const secureSetupUrl = `${runtime.localUrl}/install#s=${token}`;
  add("secure-setup", true, "Secure setup page ready (the link works only in this computer's browser).");

  return finish(runtime, { createdInstallation: created, localUrl: runtime.localUrl, publicAddressChanged, secureSetupUrl });
}

/** Which public-address provider a deployment mode may start. Hosted Railway never starts cloudflared. */
export function selectPublicEndpoint(mode: DeploymentMode, options: { publicUrl?: string; env: () => NodeJS.ProcessEnv; serviceDir: string; binDir: string }): PublicEndpointProvider | undefined {
  if (mode === "HOSTED_RAILWAY_P0") return new RailwayPublicEndpointProvider(options.env);
  if (mode === "GROK_MANAGED_P0" && !options.publicUrl) {
    return new CloudflareQuickTunnelProvider({ serviceDir: options.serviceDir, binDir: options.binDir, download: downloadFile });
  }
  if (options.publicUrl || mode !== "LOCAL_DEVELOPER") return new ManualPublicEndpointProvider(() => options.publicUrl);
  return undefined;
}

export function printReport(report: BootstrapReport, say: (line?: string) => void = (l = "") => console.log(l ? `  ${l}` : "")): void {
  say();
  say(`Tour Core bootstrap (${DEPLOYMENT_MODE_LABELS[report.deploymentMode]})`);
  say();
  for (const s of report.steps) say(`${s.ok ? "\u2713" : "\u2717"} ${s.message}`);
  say();
  if (report.localUrl) say(`Tour Core (this computer):  ${report.localUrl}`);
  if (report.connectorUrl) say(`Grok connector (OAuth):     ${report.connectorUrl}`);
  if (report.secureSetupUrl) say(`Secure setup (this computer's browser only, expires in 30 minutes):\n    ${report.secureSetupUrl}`);
  say();
  say("Installation status:");
  for (const line of report.status.lines) say(`  ${line}`);
  say();
  say(`Next step: ${report.status.nextStep.action} (${report.status.nextStep.performedBy})`);
  if (report.status.nextStep.grokInstructions) say(`For Grok: ${report.status.nextStep.grokInstructions}`);
  say();
  say(`Tell the operator: "${report.operatorMessage}"`);
  say("Don't show the operator the addresses, links, commands or process details above.");
  say();
  if (report.deploymentMode === "GROK_MANAGED_P0") say("GROK_MANAGED_P0 is a demo deployment: it runs while this cloud computer does. It isn't 24/7 production hosting.");
}

// ------------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const parsed = parseDeploymentMode(value("mode") ?? (args.includes("--grok") ? "GROK_MANAGED_P0" : process.env.TOURCORE_DEPLOYMENT_MODE));
  if (parsed && "invalid" in parsed) {
    console.error(`  Unknown deployment mode "${parsed.invalid}". Use GROK_MANAGED_P0, SELF_HOSTED, HOSTED_RAILWAY_P0 or LOCAL_DEVELOPER.`);
    process.exit(1);
  }
  const mode: DeploymentMode = parsed?.mode ?? "GROK_MANAGED_P0";
  const repoDir = fileURLToPath(new URL("../..", import.meta.url));
  const root = defaultWorkspaceRoot();
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, env: () => ({ ...process.env, TOURCORE_DEPLOYMENT_MODE: mode }) });
  useSettingsSource(installation.settingsSource());
  const port = Number(value("port") ?? 4321);
  const publicUrl = value("public-url") ?? (process.env.PUBLIC_BASE_URL?.trim() || undefined);
  const endpoint = selectPublicEndpoint(mode, { publicUrl, env: () => installation.env(), serviceDir: serviceDir(root), binDir: join(root, "bin") });
  const legacyOAuthCompat = args.includes("--strict-oauth") ? false : mode === "GROK_MANAGED_P0" ? true : undefined;
  const report = await runBootstrap(
    {
      installation,
      workspace: new PropertyWorkspace(root),
      service: new ServiceManager({ root, repoDir, port, env: { ...process.env, TOURCORE_DEPLOYMENT_MODE: mode } }),
      endpoint,
      dependencies: () => checkDependencies(repoDir),
      repository: () => checkRepositorySource({ canonical: canonicalRepoUrl(repoDir), actual: originUrl(repoDir) }),
    },
    { mode, legacyOAuthCompat },
  );
  if (args.includes("--json")) console.log(JSON.stringify({ ...report, status: { summary: report.status.summary, lines: report.status.lines, nextStep: report.status.nextStep } }, null, 2));
  else printReport(report);
  process.exit(report.ok ? 0 : 1);
}
