import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertNoSecrets } from "./manifest";
import { releaseHostedOwner } from "./hostedOwner";
import type { Installation } from "./installation";
import { SETTING_NAMES, type SettingName } from "./secretStore";
import { secretValues } from "./settings";
import { SENDBLUE_WEBHOOK_PATH, sendblueRuntime, webhookUrlFor, type SendblueEnv } from "../messaging/sendblue/runtime";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { collectCanonical } from "../storage/canonical";
import type { RuntimeNamespace } from "../storage/runtimeStore";

/**
 * Full reset of the single HOSTED_RAILWAY_P0 demo. Clears this installation's
 * business state, provider secrets, and owner binding, then starts a new
 * installation id on the same service. Does not delete the data volume, the
 * Railway service, or files already stored in Google Drive.
 */

export const RESET_HOSTED_DEMO_ACTION = "RESET_HOSTED_DEMO";

export const RESET_HOSTED_DEMO_WARNING =
  "This will erase the current Tour Core demo installation from the hosted service, including properties, prospects, tours, Sendblue setup, operator updates, OAuth connections and runtime state.\n\nIt will NOT delete the Railway service, stable hosted URL, GitHub repository, or files already saved in Google Drive.\n\nContinue?";

export const RESET_HOSTED_DEMO_SUMMARY =
  "Tour Core's hosted demo has been reset.\n\nThe Railway service and Google Drive files were kept.\n\nThe next Grok Bot will start with a fresh Tour Core installation and will need to connect visitor texting, Google Drive backups, and its first property.";

const RUNTIME_NAMESPACES: RuntimeNamespace[] = [
  "sessions",
  "verification",
  "endpoints",
  "messaging-ledger",
  "oauth",
  "probe",
  "operator-events",
  "setup-sessions",
  "approval-sessions",
  "audit-export-links",
  "portfolio-picks",
];

const INSTALLATION_SETTINGS: SettingName[] = [...SETTING_NAMES];

export type SendblueWebhookCleanup = "removed" | "not-registered" | "not-configured" | "may-remain";

export interface HostedDemoProviderCleanup {
  sendblueWebhook: SendblueWebhookCleanup;
  operatorUpdates: "cleared" | "not-configured";
  backupDestination: "cleared";
  oauth: "revoked";
  googleDriveFiles: "untouched";
  railway: "preserved";
}

export interface HostedDemoResetReport {
  resetId: string;
  previousInstallationId: string;
  installationId: string;
  resetAt: string;
  owner: "UNCLAIMED";
  result: "reset";
  providerCleanup: HostedDemoProviderCleanup;
  /** Plain language when Sendblue may still have this installation's webhook. */
  providerNote?: string;
}

interface ResetHistory {
  schemaVersion: 1;
  resets: Array<{
    resetId: string;
    previousInstallationId: string;
    newInstallationId: string;
    at: string;
    result: "reset";
    providerCleanup: HostedDemoProviderCleanup;
  }>;
}

const hookUrl = (hook: string | { url: string }) => (typeof hook === "string" ? hook : hook.url);

export function hostedDemoResetHistoryPath(root: string): string {
  return join(root, "hosted-admin", "reset-history.json");
}

/** Bound to the confirmation code. Secret values are not part of it. */
export function hostedDemoFingerprint(inst: Installation): string {
  const manifest = inst.files.readableManifest();
  const state = inst.files.state();
  const files = collectCanonical(inst.root)
    .map((file) => `${file.path}:${file.sha256}`)
    .sort();
  const flags = INSTALLATION_SETTINGS.map((name) => `${name}:${inst.secrets.get(name) ? "1" : "0"}`).join(",");
  const body = JSON.stringify({
    installationId: manifest?.installationId ?? "",
    ownerClient: state.hostedTenant?.clientId ?? "",
    backupConfiguredAt: state.portableBackup?.destination?.configuredAt ?? "",
    claimed: !!inst.secrets.hostedOwner()?.claimed,
    grants: inst.grants.connections().length,
    files,
    flags,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function hostedResetAccess(
  inst: Installation | undefined,
  caller: { clientId?: string } | undefined,
): "ok" | "unavailable" | "unauthenticated" | "not-owner" {
  if (!inst || inst.deploymentMode() !== "HOSTED_RAILWAY_P0") return "unavailable";
  const owner = inst.files.state().hostedTenant?.clientId;
  if (!caller?.clientId) return "unauthenticated";
  if (!owner || caller.clientId !== owner) return "not-owner";
  return "ok";
}

function ownedWebhookUrls(inst: Installation): string[] {
  const bases = new Set<string>();
  const current = inst.publicBaseUrl()?.replace(/\/$/, "");
  if (current) bases.add(current);
  for (const entry of inst.files.state().publicBaseUrlHistory) {
    if (entry.url) bases.add(entry.url.replace(/\/$/, ""));
  }
  return [...bases].map((base) => `${base}${SENDBLUE_WEBHOOK_PATH}`);
}

/** Removes only this installation's receive webhook. Other webhooks, the account, and the phone number stay. */
export async function removeOwnedSendblueWebhook(env: SendblueEnv, ownedUrls: string[]): Promise<SendblueWebhookCleanup> {
  if (!env.apiKey || !env.apiSecret || ownedUrls.length === 0) return "not-configured";
  try {
    const listed = (await sendblueRuntime.client(env).webhooks.list()).webhooks?.receive ?? [];
    const mine = [...new Set(listed.map(hookUrl).filter((url) => ownedUrls.includes(url)))];
    if (mine.length === 0) return "not-registered";
    await sendblueRuntime.client(env).webhooks.delete({ webhooks: mine, type: "receive" });
    return "removed";
  } catch {
    return "may-remain";
  }
}

function clearBusinessFiles(root: string): void {
  rmSync(join(root, "properties"), { recursive: true, force: true });
  rmSync(join(root, "install", "storage-audit.json"), { force: true });
  rmSync(join(root, "messaging", "ledger.json"), { force: true });
  rmSync(join(root, "portable-handoff"), { recursive: true, force: true });
}

function readHistory(root: string): ResetHistory {
  const path = hostedDemoResetHistoryPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, resets: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ResetHistory;
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.resets)) return parsed;
  } catch {
    // A damaged admin log is replaced by the new record. It is not tenant state.
  }
  return { schemaVersion: 1, resets: [] };
}

function writeHistory(root: string, history: ResetHistory, secretSnapshot: string[]): void {
  const kept = { ...history, resets: history.resets.slice(-50) };
  assertNoSecrets(kept, secretSnapshot);
  writeJsonAtomic(hostedDemoResetHistoryPath(root), kept);
}

export async function performHostedDemoReset(inst: Installation, options: { forgetProcess?: () => void } = {}): Promise<HostedDemoResetReport> {
  if (inst.deploymentMode() !== "HOSTED_RAILWAY_P0") {
    throw new Error("A full demo reset is only available on the hosted Tour Core service.");
  }
  const manifest = inst.files.manifest();
  if (!manifest) throw new Error("This hosted Tour Core has no installation to reset.");

  const secretSnapshot = secretValues(inst.env(), inst.settingsSource());
  const hadRoutine = !!inst.secrets.get("TOURCORE_GROK_ROUTINE_URL") || !!inst.secrets.get("TOURCORE_GROK_ROUTINE_KEY");
  const ownedUrls = ownedWebhookUrls(inst);
  const env = inst.sendblueEnv();
  const currentWebhook = webhookUrlFor(env);
  const urls = currentWebhook && !ownedUrls.includes(currentWebhook) ? [...ownedUrls, currentWebhook] : ownedUrls;

  options.forgetProcess?.();
  const sendblueWebhook = await removeOwnedSendblueWebhook(env, urls);
  options.forgetProcess?.();

  clearBusinessFiles(inst.root);
  for (const namespace of RUNTIME_NAMESPACES) inst.runtime.clearNamespace(namespace);
  inst.secrets.delete(INSTALLATION_SETTINGS, new Date(inst.now()));
  releaseHostedOwner(inst);
  inst.grants.revokeAll();

  const now = new Date(inst.now());
  const { previousId, manifest: next } = inst.files.freshHostedIdentity(now);
  const url = next.publicBaseUrl;
  inst.files.writeState({
    schemaVersion: 1,
    publicBaseUrlHistory: url ? [{ url, since: now.toISOString() }] : [],
  });

  const providerCleanup: HostedDemoProviderCleanup = {
    sendblueWebhook,
    operatorUpdates: hadRoutine ? "cleared" : "not-configured",
    backupDestination: "cleared",
    oauth: "revoked",
    googleDriveFiles: "untouched",
    railway: "preserved",
  };
  const report: HostedDemoResetReport = {
    resetId: `rst_${randomBytes(9).toString("base64url")}`,
    previousInstallationId: previousId,
    installationId: next.installationId,
    resetAt: now.toISOString(),
    owner: "UNCLAIMED",
    result: "reset",
    providerCleanup,
    ...(sendblueWebhook === "may-remain"
      ? { providerNote: "Sendblue may still have this installation's incoming-message address. It was not removed. Nothing else on that account was changed." }
      : {}),
  };
  const history = readHistory(inst.root);
  history.resets.push({
    resetId: report.resetId,
    previousInstallationId: report.previousInstallationId,
    newInstallationId: report.installationId,
    at: report.resetAt,
    result: "reset",
    providerCleanup,
  });
  writeHistory(inst.root, history, secretSnapshot);
  options.forgetProcess?.();
  return report;
}
