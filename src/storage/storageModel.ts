import type { DeploymentMode } from "../install/deployment";

/**
 * Where live operational records are kept.
 *
 * HOSTED_P0_VOLUME is the HOSTED_RAILWAY_P0 default: the Railway volume is the
 * live store. Grok's Google Drive connector is only a portable backup.
 *
 * DIRECT_GOOGLE_DRIVE is optional. Tour Core itself holds a Google refresh
 * token and treats Drive as the live store. It is not the hosted product path.
 * Set TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE to use it.
 *
 * LOCAL_DEMO keeps records on the Tour Core computer (open-source demo).
 */
export const STORAGE_MODELS = ["HOSTED_P0_VOLUME", "DIRECT_GOOGLE_DRIVE", "LOCAL_DEMO"] as const;
export type StorageModel = (typeof STORAGE_MODELS)[number];

export function resolveStorageModel(input: {
  deploymentMode: DeploymentMode;
  env: NodeJS.ProcessEnv;
  manifestProvider?: "LOCAL_DEMO" | "GOOGLE_DRIVE";
}): StorageModel {
  const explicit = input.env.TOURCORE_STORAGE_MODEL?.trim().toUpperCase().replace(/-/g, "_");
  if (explicit === "DIRECT_GOOGLE_DRIVE") return "DIRECT_GOOGLE_DRIVE";
  // A touring host on the shared service keeps its records on that service's volume, too.
  if (input.deploymentMode === "HOSTED_RAILWAY_P0" || input.deploymentMode === "TENANT_WORKER") return "HOSTED_P0_VOLUME";
  if (input.manifestProvider === "GOOGLE_DRIVE") return "DIRECT_GOOGLE_DRIVE";
  return "LOCAL_DEMO";
}
