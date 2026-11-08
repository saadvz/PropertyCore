import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { NotificationPreferences } from "../alerts/preferences";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { DEPLOYMENT_MODES, type DeploymentMode } from "./deployment";

/**
 * The installation manifest: a versioned, non-secret description of this
 * Tour Core installation (how it's deployed, where it's reachable, which
 * provider fills each role). Credentials are never part of it; they live in
 * the SecretStore and are referenced only by role.
 *
 * Alongside it, the install state keeps the results of installation checks
 * (and which public address each dependent component was set up against), so
 * a changed address can be detected instead of silently used.
 */

export const PUBLIC_ENDPOINT_PROVIDERS = ["NONE", "MANUAL", "CLOUDFLARE_QUICK_TUNNEL", "RAILWAY"] as const;
export type PublicEndpointProviderKind = (typeof PUBLIC_ENDPOINT_PROVIDERS)[number];

export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deploymentMode: z.enum(DEPLOYMENT_MODES),
  installationId: z.string().regex(/^inst_[A-Za-z0-9_-]{12,60}$/),
  publicBaseUrl: z.url({ protocol: /^https$/ }).optional(),
  publicEndpointProvider: z.enum(PUBLIC_ENDPOINT_PROVIDERS),
  messagingProvider: z.enum(["UNSET", "SENDBLUE", "TWILIO", "PHOTON", "LOCAL", "DEMO"]),
  /** GOOGLE_DRIVE is canonical portable storage. LOCAL_DEMO stays on this computer. */
  storageProvider: z.enum(["LOCAL_DEMO", "GOOGLE_DRIVE"]),
  /** DOOR_DEMO was saved as DURIN_DEMO before saadvz/PropertyCore#179; that spelling still reads. */
  accessProvider: z.preprocess((v) => (v === "DURIN_DEMO" ? "DOOR_DEMO" : v), z.enum(["DOOR_DEMO"])),
  operatorNotificationProvider: z.enum(["NONE", "GROK_ROUTINE"]),
  options: z
    .strictObject({
      /** P0: accept Grok's current legacy OAuth callback (same as TOURCORE_GROK_LEGACY_OAUTH_COMPAT). */
      grokLegacyOAuthCompat: z.boolean().optional(),
    })
    .optional(),
  installedAt: z.string(),
  updatedAt: z.string(),
});
export type InstallationManifest = z.infer<typeof ManifestSchema>;

export interface CheckResult {
  ok: boolean;
  at: string;
  /** Plain language, never a credential. */
  message: string;
}

export interface InstallState {
  schemaVersion: 1;
  publicBaseUrlHistory: { url: string; since: string; until?: string }[];
  publicEndpointCheck?: CheckResult & { url: string };
  visitorMessaging?: CheckResult & { publicBaseUrl?: string; webhookUrl?: string; problems: string[]; provider?: "sendblue" | "twilio" | "photon" | "local" };
  /** Set when the operator chooses a provider, or when a working Sendblue install is migrated once. */
  messagingProviderChoice?: "sendblue" | "twilio" | "photon" | "local";
  /** Provisioned lines last reported by the active provider. Phone numbers only, never secrets. */
  messagingLines?: { id: string; address: string; status?: string }[];
  /** credentialsChangedAt: when the routine settings were last changed, so an old test doesn't vouch for new ones. clearedFailures: misses a passing test covered by each record's own time. */
  operatorAlerts?: CheckResult & { credentialsChangedAt?: string; clearedFailures?: { eventId: string; lastAttemptAt?: string }[] };
  /** Exceptions that existed before operator alerts were first set up aren't announced. */
  alertsBaselineAt?: string;
  /** Which operator updates the landlord chose. Unset: only issues that need them. */
  operatorUpdates?: NotificationPreferences;
  /** RECOMMENDED components the operator declined, and when. Turning one on later clears nothing; configuring it wins. */
  skipped?: Partial<Record<string, string>>;
  /**
   * HOSTED_RAILWAY_P0 only. The first approved operator client. A different
   * client is refused. Not a secret. Marketplace tenancy is not this field.
   */
  hostedTenant?: { clientId: string; boundAt: string };
  /** Where canonical tour records live when DIRECT_GOOGLE_DRIVE is in use. Tokens are never stored here. */
  storage?: {
    mode?: "LOCAL_DEMO" | "GOOGLE_DRIVE";
    phase?: "CONNECTING" | "READY" | "MIGRATING" | "ERROR";
    chosenAt?: string;
    folderId?: string;
    folderName?: string;
    accountEmail?: string;
    storeId?: string;
    hostId?: string;
    cacheValidatedAt?: string;
    error?: string;
    migration?: {
      id: string;
      phase: "PREPARED" | "COPYING" | "COPIED" | "VERIFIED" | "FAILED" | "ACTIVATED";
      startedAt: string;
      updatedAt: string;
      copied: string[];
      hashes: Record<string, string>;
      error?: string;
    };
  };
  /**
   * HOSTED_P0_VOLUME only. Non-secret metadata about the Grok Drive backup
   * destination. Tour Core does not store a Google token here.
   */
  portableBackup?: {
    destination?: {
      provider: "google_drive";
      folderName: string;
      accountLabel?: string;
      configuredAt: string;
    };
    declinedAt?: string;
    lastBackupCreatedAt?: string;
    lastBackupConfirmedInDriveAt?: string;
    lastBackupChecksum?: string;
    lastBackupSchemaVersion?: number;
    lastBackupFileName?: string;
    lastFailureAt?: string;
    lastFailureSummary?: string;
  };
}

export class ManifestSecretError extends Error {}

export const installationPaths = (root: string) => ({
  dir: join(root, "install"),
  manifest: join(root, "install", "manifest.json"),
  state: join(root, "install", "state.json"),
  secrets: join(root, "install", "secrets.json"),
});

export const newInstallationId = () => `inst_${randomBytes(12).toString("base64url")}`;

/** Refuses to write a manifest that contains any secret value, even inside an allowed field. */
export function assertNoSecrets(manifest: unknown, secretValues: string[]): void {
  const text = JSON.stringify(manifest);
  for (const value of secretValues) {
    if (value.length >= 6 && text.includes(value)) throw new ManifestSecretError("The installation manifest may not contain a credential.");
  }
}

export class InstallationFiles {
  readonly paths: ReturnType<typeof installationPaths>;
  private cached?: { mtimeMs: number; manifest: InstallationManifest };

  constructor(
    readonly root: string,
    private readonly secretValues: () => string[] = () => [],
  ) {
    this.paths = installationPaths(root);
  }

  /** The manifest, or undefined before the first install. A damaged manifest throws (never treated as blank). */
  manifest(): InstallationManifest | undefined {
    const path = this.paths.manifest;
    if (!existsSync(path)) return undefined;
    const mtimeMs = statSync(path).mtimeMs;
    if (this.cached?.mtimeMs === mtimeMs) return this.cached.manifest;
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error("The installation manifest couldn't be read. Run the Tour Core bootstrap again to repair it.");
    this.cached = { mtimeMs, manifest: parsed.data };
    return parsed.data;
  }

  /** The manifest, or undefined when it is missing or can't be read. */
  readableManifest(): InstallationManifest | undefined {
    try {
      return this.manifest();
    } catch {
      return undefined;
    }
  }

  private writeManifest(manifest: InstallationManifest): InstallationManifest {
    const valid = ManifestSchema.parse(manifest);
    assertNoSecrets(valid, this.secretValues());
    writeJsonAtomic(this.paths.manifest, valid);
    this.cached = undefined;
    return valid;
  }

  /**
   * Creates the manifest the first time, or brings an existing one up to date.
   * The installation id never changes once created, so running setup twice
   * repairs the same installation instead of making a second one.
   */
  ensure(input: { deploymentMode: DeploymentMode; now?: Date; options?: InstallationManifest["options"] }): { manifest: InstallationManifest; created: boolean } {
    const now = (input.now ?? new Date()).toISOString();
    const existing = this.manifest();
    if (existing) {
      const options = input.options ? { ...existing.options, ...input.options } : existing.options;
      const unchanged = existing.deploymentMode === input.deploymentMode && JSON.stringify(options ?? null) === JSON.stringify(existing.options ?? null);
      if (unchanged) return { manifest: existing, created: false };
      return { manifest: this.writeManifest({ ...existing, deploymentMode: input.deploymentMode, ...(options ? { options } : {}), updatedAt: now }), created: false };
    }
    const manifest = this.writeManifest({
      schemaVersion: 1,
      deploymentMode: input.deploymentMode,
      installationId: newInstallationId(),
      publicEndpointProvider: "NONE",
      messagingProvider: "UNSET",
      storageProvider: "LOCAL_DEMO",
      accessProvider: "DOOR_DEMO",
      operatorNotificationProvider: "NONE",
      ...(input.options ? { options: input.options } : {}),
      installedAt: now,
      updatedAt: now,
    });
    return { manifest, created: true };
  }

  /**
   * Starts a new installation id on the same hosted service. Keeps the
   * deployment mode, public address, and host options. Clears nothing else;
   * the caller clears business state first.
   */
  freshHostedIdentity(now = new Date()): { previousId: string; manifest: InstallationManifest } {
    const existing = this.manifest();
    if (!existing || existing.deploymentMode !== "HOSTED_RAILWAY_P0") {
      throw new Error("A new hosted installation can only replace the hosted demo.");
    }
    const stamp = now.toISOString();
    const manifest = this.writeManifest({
      schemaVersion: 1,
      deploymentMode: existing.deploymentMode,
      installationId: newInstallationId(),
      ...(existing.publicBaseUrl ? { publicBaseUrl: existing.publicBaseUrl } : {}),
      publicEndpointProvider: existing.publicEndpointProvider,
      messagingProvider: existing.messagingProvider,
      storageProvider: existing.storageProvider,
      accessProvider: existing.accessProvider,
      operatorNotificationProvider: "NONE",
      ...(existing.options ? { options: existing.options } : {}),
      installedAt: stamp,
      updatedAt: stamp,
    });
    return { previousId: existing.installationId, manifest };
  }

  update(patch: Partial<Omit<InstallationManifest, "schemaVersion" | "installationId" | "installedAt">>, now = new Date()): InstallationManifest {
    const existing = this.manifest() ?? this.ensure({ deploymentMode: "LOCAL_DEVELOPER", now }).manifest;
    return this.writeManifest({ ...existing, ...patch, updatedAt: now.toISOString() });
  }

  /**
   * Records the public address. A different address from last time is
   * reported as a change: everything set up against the old one (Grok's
   * connection, the messaging webhook, identity-form links) needs attention.
   */
  setPublicBaseUrl(url: string | undefined, provider: PublicEndpointProviderKind, now = new Date()): { changed: boolean; previous?: string } {
    const current = this.manifest();
    const previous = current?.publicBaseUrl;
    if (previous === url && current?.publicEndpointProvider === provider) return { changed: false, previous };
    this.update({ publicBaseUrl: url, publicEndpointProvider: provider }, now);
    if (previous !== url) {
      const state = this.state();
      const history = state.publicBaseUrlHistory.map((h) => (h.until ? h : { ...h, until: now.toISOString() }));
      if (url) history.push({ url, since: now.toISOString() });
      this.writeState({ ...state, publicBaseUrlHistory: history.slice(-10) });
    }
    return { changed: previous !== url && previous !== undefined, previous };
  }

  state(): InstallState {
    if (!existsSync(this.paths.state)) return { schemaVersion: 1, publicBaseUrlHistory: [] };
    try {
      const doc = JSON.parse(readFileSync(this.paths.state, "utf8")) as InstallState;
      return { ...doc, publicBaseUrlHistory: doc.publicBaseUrlHistory ?? [] };
    } catch {
      // Only check results live here; losing them means the checks run again.
      return { schemaVersion: 1, publicBaseUrlHistory: [] };
    }
  }

  writeState(state: InstallState): void {
    assertNoSecrets(state, this.secretValues());
    writeJsonAtomic(this.paths.state, state);
  }

  recordCheck<K extends "publicEndpointCheck" | "visitorMessaging" | "operatorAlerts">(key: K, value: InstallState[K]): void {
    this.writeState({ ...this.state(), [key]: value });
  }
}
