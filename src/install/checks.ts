import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installationAlertHealth, problemsToClear } from "../alerts/alertHealth";
import { testEvent } from "../alerts/operatorEvents";
import { MockDurinAccessAdapter } from "../durin/MockDurinAccessAdapter";
import { activeFromNumber, createMessagingProvider, ensureMessagingSelection, manifestProviderName } from "../messaging/registry";
import type { SettingName } from "./secretStore";
import type { OperatorServices } from "../operator/services";
import { writeFileAtomic } from "../storage/atomicWrite";
import { probeRuntimeStore } from "../storage/runtimeStore";
import { TOURCORE_VERSION, type Installation } from "./installation";
import { storageVolumeHealth, type StorageVolumeHealth } from "./persistentVolume";
import { LOCAL_TEST_TEXTING } from "../setup/setupActions";

/**
 * The installation checks behind Tour Core's installation tools. Each one
 * does a real check, records the plain-language result in the install state
 * (never a credential), and returns what the operator should be told.
 */

export const HEALTH_PATH = "/healthz";

/** Public health and runtime health. GitHub Actions always sets GITHUB_SHA, which is not this deploy. */
const HEALTH_COMMIT_ENV_VARS = ["RAILWAY_GIT_COMMIT_SHA", "TOURCORE_COMMIT_SHA", "GIT_COMMIT_SHA"] as const;

/** Same order, then other hosts, for the QA installation status only. */
const QA_COMMIT_ENV_VARS = [
  ...HEALTH_COMMIT_ENV_VARS,
  "GITHUB_SHA",
  "SOURCE_VERSION",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "CF_PAGES_COMMIT_SHA",
] as const;

function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** Railway injects this on GitHub deploys. Self-hosted can set the Tour Core or generic override. */
function deployedCommitSha(env: NodeJS.ProcessEnv): string | null {
  return firstSet(env, HEALTH_COMMIT_ENV_VARS);
}

/** Full deploy SHA for the QA connector, or "unknown" when the host didn't set one. */
export function deployedCommitLabel(env: NodeJS.ProcessEnv): string {
  return firstSet(env, QA_COMMIT_ENV_VARS) ?? "unknown";
}

/** Identifies this installation on the public health page without revealing its id. */
export const installationFingerprint = (installationId: string | undefined) =>
  installationId ? createHash("sha256").update(`tour-core|${installationId}`).digest("hex").slice(0, 16) : undefined;

export interface PublicHealth extends StorageVolumeHealth {
  ok: true;
  service: "tour-core";
  commit: string | null;
  installation?: string;
}

export function publicHealth(inst: Installation): PublicHealth {
  const id = inst.files.readableManifest()?.installationId;
  const fingerprint = installationFingerprint(id);
  return {
    ok: true,
    service: "tour-core",
    commit: deployedCommitSha(inst.env()),
    ...(fingerprint ? { installation: fingerprint } : {}),
    ...storageVolumeHealth(inst.options.root),
  };
}

export function runtimeHealth(inst: Installation) {
  const deployment = inst.deployment();
  let storageOk = true;
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    storageOk = false;
  }
  const alerts = installationAlertHealth(inst);
  return {
    running: true,
    version: TOURCORE_VERSION,
    commit: deployedCommitSha(inst.env()),
    pid: process.pid,
    uptimeSeconds: Math.round((inst.now() - inst.startedAt) / 1000),
    deploymentMode: deployment.mode,
    runtimeRecords: storageOk ? "ok" : "can't be saved",
    alertsWaiting: alerts.pending,
    alertDelivery: alerts,
    ...storageVolumeHealth(inst.options.root),
  };
}

/** Fetches the public health page through the public address and checks it's this installation answering. */
export async function checkPublicEndpoint(inst: Installation, options: { attempts?: number; delayMs?: number } = {}): Promise<{ ok: boolean; url?: string; message: string }> {
  const url = inst.publicBaseUrl();
  if (!url) return { ok: false, message: "Tour Core doesn't have a public https address yet." };
  const expected = publicHealth(inst).installation;
  const attempts = options.attempts ?? 1;
  let message = "Tour Core's public address didn't answer.";
  let ok = false;
  for (let i = 0; i < attempts && !ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, options.delayMs ?? 3000));
    try {
      const res = await inst.fetch()(`${url}${HEALTH_PATH}`, { signal: AbortSignal.timeout(10_000) });
      const body = res.status === 200 ? ((await res.json().catch(() => undefined)) as Partial<PublicHealth> | undefined) : undefined;
      if (body?.service !== "tour-core") message = `Tour Core's public address answered, but not with Tour Core (status ${res.status}).`;
      else if (expected && body.installation !== expected) message = "Tour Core's public address reaches a different Tour Core installation.";
      else {
        ok = true;
        message = "Tour Core is reachable at its public address.";
      }
    } catch {
      message = "Tour Core's public address didn't answer.";
    }
  }
  inst.files.recordCheck("publicEndpointCheck", { ok, at: new Date(inst.now()).toISOString(), message, url });
  return { ok, url, message };
}

/**
 * Checks visitor messaging end to end and repairs what Tour Core owns: its
 * own incoming-message webhook for the current public address (removing the
 * one for a previous address) and the webhook secret. Account details are
 * never changed here; they're entered on the secure setup page.
 */
export async function testVisitorMessaging(inst: Installation, options: { onConnected?: () => void } = {}) {
  const selection = ensureMessagingSelection(inst);
  if (selection.invalid || !selection.provider) {
    const message = selection.invalid ? `Tour Core doesn't include a messaging provider named "${selection.invalid}".` : "Choose how prospects will text Tour Core first.";
    return { ok: false, message, checks: [], incomingMessages: "Not changed." };
  }
  const provider = createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv(), now: () => new Date(inst.now()) });
  const previous = inst.files.state().visitorMessaging?.webhookUrl;
  const result = await provider.connect({
    saveSecret: (values) => inst.secrets.set(values as Partial<Record<SettingName, string>>, new Date(inst.now())),
    previousWebhookUrl: previous,
  });
  const problems = [...(result.problem ? [result.problem] : []), ...result.checks.filter((c) => !c.ok).map((c) => c.message)];
  const message = result.ok ? (selection.provider === "local" ? LOCAL_TEST_TEXTING : "Visitor texting is connected.") : (problems[0] ?? "Visitor texting isn't connected yet.");
  const number = activeFromNumber(inst);
  inst.files.recordCheck("visitorMessaging", {
    ok: result.ok,
    at: new Date(inst.now()).toISOString(),
    message,
    problems,
    provider: selection.provider,
    ...(inst.publicBaseUrl() ? { publicBaseUrl: inst.publicBaseUrl() } : {}),
    ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : previous ? { webhookUrl: previous } : {}),
  });
  if (result.ok) {
    inst.files.update({ messagingProvider: manifestProviderName(selection.provider) }, new Date(inst.now()));
    options.onConnected?.();
  }
  if (result.lines) {
    const state = inst.files.state();
    inst.files.writeState({ ...state, messagingLines: result.lines });
  }
  const who = provider.displayName;
  return {
    ok: result.ok,
    message,
    checks: result.checks.map((c) => ({ check: c.label, ok: c.ok, message: c.message })),
    incomingMessages:
      result.webhook === "registered"
        ? `Registered Tour Core's incoming-message address with ${who}.`
        : result.webhook === "re-registered"
          ? `Updated Tour Core's incoming-message address with ${who}.`
          : result.webhook === "already-registered"
            ? `${who} already sends visitor replies to Tour Core.`
            : "Not changed.",
    ...(result.removedPreviousWebhook ? { previousAddress: `Removed Tour Core's old incoming-message address from ${who}.` } : {}),
    ...(number ? { textingNumber: number } : {}),
    ...(result.lines ? { lines: result.lines } : {}),
    ...(result.needsLineChoice ? { needsLineChoice: true } : {}),
  };
}

/** When the Grok Routine's address or key last changed. The alert test records it and the status compares it, so an old test doesn't vouch for new settings. */
export function routineCredentialsChangedAt(inst: Installation): string | undefined {
  return [inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")]
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
}

/** Sends one test event to the operator alert channel and records whether it was accepted. */
export async function testOperatorAlerts(inst: Installation) {
  const sink = inst.sink();
  const credentialsChangedAt = routineCredentialsChangedAt(inst);
  const at = new Date(inst.now());
  if (!sink.configured()) {
    return { ok: false, message: "Operator alerts aren't connected yet. The Grok Routine's details go in on the secure setup page." };
  }
  let ok = false;
  let message: string;
  try {
    await sink.deliver(testEvent(at));
    ok = true;
    message = "Sent a test update. The Tour Core Operator Updates routine should wake up and post a short confirmation.";
  } catch (err) {
    message = err instanceof Error ? err.message : "The test alert couldn't be delivered.";
  }
  const clearedFailures = ok ? problemsToClear(inst.outbox.records()) : undefined;
  inst.files.recordCheck("operatorAlerts", {
    ok,
    at: at.toISOString(),
    message,
    ...(credentialsChangedAt ? { credentialsChangedAt } : {}),
    ...(clearedFailures ? { clearedFailures } : {}),
  });
  if (ok) {
    inst.files.update({ operatorNotificationProvider: "GROK_ROUTINE" }, at);
    void inst.outbox.drain().catch(() => undefined);
  }
  return { ok, message };
}

/** Saves, reads back and removes a test record in both the tour records folder and the runtime records. */
export async function testStorage(inst: Installation, services: OperatorServices) {
  const problems: string[] = [];
  try {
    probeRuntimeStore(inst.runtime, new Date(inst.now()));
  } catch {
    problems.push("Running tours couldn't be saved.");
  }
  const probe = join(services.workspace.root, `.probe-${randomBytes(6).toString("hex")}`);
  try {
    writeFileAtomic(probe, "tour-core");
    if (!existsSync(probe) || readFileSync(probe, "utf8") !== "tour-core") throw new Error("mismatch");
  } catch {
    problems.push("Tour records couldn't be saved.");
  } finally {
    rmSync(probe, { force: true });
  }
  if (!problems.length && inst.records.provider() === "GOOGLE_DRIVE_READY") {
    try {
      await inst.records.probe();
    } catch {
      problems.push("Google Drive didn't save a test record.");
    }
  }
  const provider = inst.records.provider();
  const where = provider === "GOOGLE_DRIVE_READY" ? "Tour records: Google Drive connected." : provider === "LOCAL_DEMO" ? "Tour records: Stored locally." : inst.records.summary();
  return {
    ok: problems.length === 0,
    provider,
    message: problems.length ? problems.join(" ") : `${where} A test record saved and read back correctly.`,
  };
}

export async function testAccess(inst: Installation) {
  const durin = new MockDurinAccessAdapter({ doorNames: {}, timeZone: "UTC", now: () => new Date(inst.now()) });
  const health = await durin.getHealth();
  return {
    ok: health.healthy,
    accessSystem: "Demo",
    message: health.healthy ? "Access system: Demo. It's answering, and no real doors open." : "Access system: Demo, but it isn't answering.",
  };
}
