/**
 * How this Tour Core is installed and who runs it.
 *
 *  LOCAL_DEVELOPER    a developer's own computer: `npm run setup`, a local
 *                     browser, a manual tunnel and `.env`. The default.
 *  GROK_MANAGED_P0    installed and run by Grok on its own cloud computer
 *                     (`npm run bootstrap:grok`). A temporary demo, not the
 *                     hosted product.
 *  SELF_HOSTED        already running at a stable https address the operator
 *                     runs; Grok only connects and drives configuration.
 *  HOSTED_RAILWAY_P0  one Tour Core service we run on Railway for the demo.
 *                     Landlords do not create Railway projects. Single-tenant:
 *                     Marketplace publication requires tenant isolation.
 *  TENANT_WORKER      one touring host's Tour Core on the shared multi-tenant
 *                     service: a private process the service starts, reached
 *                     only on loopback with the key it was given.
 *
 * The mode changes how the installation is set up and reached, never a tour,
 * policy or access rule.
 */

export const DEPLOYMENT_MODES = ["LOCAL_DEVELOPER", "GROK_MANAGED_P0", "SELF_HOSTED", "HOSTED_RAILWAY_P0", "TENANT_WORKER"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

const ALIASES: Record<string, DeploymentMode> = {
  local_developer: "LOCAL_DEVELOPER",
  local: "LOCAL_DEVELOPER",
  developer: "LOCAL_DEVELOPER",
  grok_managed_p0: "GROK_MANAGED_P0",
  grok_managed: "GROK_MANAGED_P0",
  grok: "GROK_MANAGED_P0",
  self_hosted: "SELF_HOSTED",
  selfhosted: "SELF_HOSTED",
  hosted_railway_p0: "HOSTED_RAILWAY_P0",
  hosted_railway: "HOSTED_RAILWAY_P0",
  railway: "HOSTED_RAILWAY_P0",
  hosted: "HOSTED_RAILWAY_P0",
  tenant_worker: "TENANT_WORKER",
};

export type ParsedDeploymentMode = { mode: DeploymentMode } | { invalid: string };

/** Accepts the canonical names and a few friendly spellings ("grok", "self-hosted"). Blank means "not set". */
export function parseDeploymentMode(raw: string | undefined): ParsedDeploymentMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const mode = ALIASES[value.toLowerCase().replace(/[\s-]+/g, "_")];
  return mode ? { mode } : { invalid: value };
}

/**
 * TOURCORE_DEPLOYMENT_MODE wins, then what the installation manifest recorded,
 * then LOCAL_DEVELOPER. An unreadable value falls back to the manifest/default
 * and is reported so the operator can fix it.
 */
export function resolveDeploymentMode(env: NodeJS.ProcessEnv = process.env, recorded?: DeploymentMode): { mode: DeploymentMode; source: "environment" | "manifest" | "default"; invalid?: string } {
  const parsed = parseDeploymentMode(env.TOURCORE_DEPLOYMENT_MODE);
  if (parsed && "mode" in parsed) return { mode: parsed.mode, source: "environment" };
  const invalid = parsed && "invalid" in parsed ? parsed.invalid : undefined;
  if (recorded) return { mode: recorded, source: "manifest", ...(invalid ? { invalid } : {}) };
  return { mode: "LOCAL_DEVELOPER", source: "default", ...(invalid ? { invalid } : {}) };
}

export const DEPLOYMENT_MODE_LABELS: Record<DeploymentMode, string> = {
  LOCAL_DEVELOPER: "Developer computer",
  GROK_MANAGED_P0: "Grok's cloud computer (demo)",
  SELF_HOSTED: "Self-hosted",
  HOSTED_RAILWAY_P0: "Hosted Railway demo (single-tenant)",
  TENANT_WORKER: "Touring for one host on the shared service",
};

export const isHostedRailway = (mode: DeploymentMode) => mode === "HOSTED_RAILWAY_P0";
export const isTenantWorker = (mode: DeploymentMode) => mode === "TENANT_WORKER";
