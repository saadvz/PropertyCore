import { randomBytes } from "node:crypto";
import type { InstallationFiles } from "../install/manifest";
import type { SecretStore, SettingName } from "../install/secretStore";
import { SECRET_SETTING_NAMES } from "../install/secretStore";
import type { DeploymentMode } from "../install/deployment";
import type { TourCoreStore } from "./Store";
import { InMemoryStore } from "./Store";
import {
  appendStorageAudit,
  buildLookup,
  claimLease,
  collectCanonical,
  copyMigration,
  factReadMode,
  prepareMigration,
  releaseLease,
  restoreCanonical,
  tourHistoryCsv,
  verifyMigration,
  type MigrationProgress,
} from "./canonical";
import { DurableTourStore } from "./durableTourStore";
import { StorageUnavailableError, StoreBusyError } from "./errors";
import { GoogleDriveStore, type DriveClient } from "./googleDrive";
import { authorizationUrl, checkState, createPending, exchangeCode, googleClientConfig, googleEmail, redirectUriFor, refreshAccess, revokeToken, type OAuthPending } from "./googleOAuth";
import { resolveStorageModel, type StorageModel } from "./storageModel";
import { HttpDriveClient } from "./httpDrive";

const LEASE_TTL_MS = 2 * 60_000;

export interface RecordStoreDeps {
  root: string;
  now: () => number;
  deploymentMode: () => DeploymentMode;
  files: InstallationFiles;
  secrets: SecretStore;
  publicBaseUrl: () => string | undefined;
  env: () => NodeJS.ProcessEnv;
  fetch: () => (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown>; text?: () => Promise<string> }>;
  /** Tests pass a fake. Production uses the Google Drive HTTP API. */
  driveClient?: DriveClient;
}

/**
 * Installation-level canonical storage. Local demo keeps today's files.
 * Google Drive, when active, is the canonical copy; the local folder is only
 * a cache that is rebuilt from Drive.
 */
export class RecordStore {
  private remote?: GoogleDriveStore;
  private down = false;
  /** When a test forces Drive down, fact reads may still use a fresh cache. */
  private cacheValidatedAt?: number;

  constructor(private readonly deps: RecordStoreDeps) {}

  /** Test hook: Drive answers or doesn't. Direct Google Drive mode only. */
  setDriveReachable(up: boolean, cacheValidatedAt?: number): void {
    this.down = !up;
    if (cacheValidatedAt !== undefined) this.cacheValidatedAt = cacheValidatedAt;
  }

  model(): StorageModel {
    return resolveStorageModel({
      deploymentMode: this.deps.deploymentMode(),
      env: this.deps.env(),
      manifestProvider: this.deps.files.readableManifest()?.storageProvider,
    });
  }

  provider(): "NOT_CONFIGURED" | "LOCAL_DEMO" | "HOSTED_VOLUME" | "GOOGLE_DRIVE_CONNECTING" | "GOOGLE_DRIVE_READY" | "ERROR" {
    if (this.model() === "HOSTED_P0_VOLUME") return "HOSTED_VOLUME";
    const state = this.deps.files.state().storage;
    const manifest = this.deps.files.readableManifest();
    if (state?.phase === "MIGRATING") return "GOOGLE_DRIVE_CONNECTING";
    if (state?.phase === "ERROR" || state?.error) return "ERROR";
    if (manifest?.storageProvider === "GOOGLE_DRIVE" && this.refreshToken()) return "GOOGLE_DRIVE_READY";
    if (state?.phase === "CONNECTING" || (this.refreshToken() && manifest?.storageProvider !== "GOOGLE_DRIVE")) return "GOOGLE_DRIVE_CONNECTING";
    if (state?.mode === "LOCAL_DEMO") return "LOCAL_DEMO";
    if (this.deps.deploymentMode() === "LOCAL_DEVELOPER") return "LOCAL_DEMO";
    return "NOT_CONFIGURED";
  }

  driveUp(): boolean {
    return this.provider() === "GOOGLE_DRIVE_READY" && !this.down;
  }

  storageRead(): "live" | "cached" | "stale" {
    if (this.provider() !== "GOOGLE_DRIVE_READY") return "live";
    return factReadMode({ driveUp: this.driveUp(), cacheValidatedAt: this.cacheValidatedAt ?? Date.parse(this.deps.files.state().storage?.cacheValidatedAt ?? ""), now: this.deps.now() });
  }

  async beforeAccess(): Promise<void> {
    if (this.provider() !== "GOOGLE_DRIVE_READY") return;
    if (!this.driveUp()) throw new StorageUnavailableError("Tour records couldn't be confirmed, so the door stays closed.");
    await this.remoteStore();
  }

  wrapStore(inner: TourCoreStore = new InMemoryStore()): TourCoreStore {
    if (this.provider() !== "GOOGLE_DRIVE_READY") return inner;
    return new DurableTourStore(inner, () => this.remote, () => this.driveUp() && !!this.remote);
  }

  summary(): string {
    switch (this.provider()) {
      case "GOOGLE_DRIVE_READY":
        return "Tour records: Google Drive connected.";
      case "GOOGLE_DRIVE_CONNECTING":
        return "Google Drive is waiting for approval.";
      case "ERROR":
        return this.deps.files.state().storage?.error ?? "Google Drive isn't available right now.";
      case "LOCAL_DEMO":
        return "Tour records: Stored locally.";
      case "HOSTED_VOLUME":
        return this.hostedSummary();
      default:
        return "Offered once visitor texting is working.";
    }
  }

  private hostedSummary(): string {
    const backup = this.deps.files.state().portableBackup;
    const portable = backup?.destination ? "Google Drive connected" : "not connected";
    return `Operational records: Stored by hosted Tour Core. Portable backup: ${portable}.`;
  }

  location(): { provider: string; folderName?: string; folderId?: string; description: string } {
    const state = this.deps.files.state().storage;
    const provider = this.provider();
    if (provider === "GOOGLE_DRIVE_READY" || provider === "GOOGLE_DRIVE_CONNECTING") {
      return {
        provider,
        ...(state?.folderName ? { folderName: state.folderName } : { folderName: "Tour Core" }),
        ...(state?.folderId ? { folderId: state.folderId } : {}),
        description: state?.accountEmail ? `Tour Core folder in Google Drive (${state.accountEmail}).` : "Tour Core folder in Google Drive.",
      };
    }
    if (provider === "HOSTED_VOLUME") {
      const backup = this.deps.files.state().portableBackup;
      return {
        provider,
        description: backup?.destination ? "Operational records are stored by hosted Tour Core. Portable backups go to the Tour Core folder in Google Drive." : "Operational records are stored by hosted Tour Core. Portable Google Drive backup is not connected.",
        ...(backup?.destination ? { folderName: backup.destination.folderName } : {}),
      };
    }
    return { provider: provider === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "LOCAL_DEMO", description: "Stored on this Tour Core computer. These records are not portable." };
  }

  useLocalDemo(): { summary: string } {
    if (this.provider() === "GOOGLE_DRIVE_READY") {
      return { summary: "Google Drive is already where records are kept. Disconnect it if you want them only on this computer." };
    }
    const now = new Date(this.deps.now()).toISOString();
    const state = this.deps.files.state();
    this.deps.files.writeState({ ...state, storage: { ...state.storage, mode: "LOCAL_DEMO", phase: "READY", chosenAt: now, error: undefined } });
    return { summary: "Your records are stored with this demo installation and won't be portable if this Tour Core computer is replaced." };
  }

  beginConnect(): { configured: true; authorizationUrl: string; summary: string; grok: string } | { configured: false; summary: string; technical: string } {
    if (this.model() === "HOSTED_P0_VOLUME") {
      return {
        configured: false,
        summary: "On hosted Tour Core, connect Google Drive through me for portable backups. Tour Core does not use a separate Google approval.",
        technical:
          "HOSTED_P0_VOLUME does not use Tour Core Google OAuth. Do not ask for TOURCORE_GOOGLE_WEB_CLIENT_ID, TOURCORE_GOOGLE_WEB_CLIENT_SECRET, TOURCORE_GOOGLE_OAUTH_CLIENT_ID, or a refresh token. Use Grok's native Google Drive connector, create or find the private Tour Core folder, then call confirm_backup_destination. DIRECT_GOOGLE_DRIVE is optional and only when TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE.",
      };
    }
    const config = googleClientConfig(this.deps.env(), (name) => this.deps.secrets.get(name as SettingName));
    if (!config.clientId || !config.clientSecret) {
      return {
        configured: false,
        summary: "Connecting Google Drive needs Tour Core's Google app, which isn't on this computer yet. I can keep records here for now, but they won't move if this computer is replaced.",
        technical:
          "A distributor configures TOURCORE_GOOGLE_OAUTH_CLIENT_ID and TOURCORE_GOOGLE_OAUTH_CLIENT_SECRET for the shared Tour Core Google OAuth client (Authorization Code + PKCE, scope drive.file plus userinfo.email). Landlords do not create a Google Cloud project. A developer can set those variables on this computer. There is no documented xAI API that lets Tour Core use Grok's Google Drive connector token, so Tour Core's own consent is still required once a client id exists.",
      };
    }
    const pending = createPending(redirectUriFor(this.deps.publicBaseUrl()), this.deps.now());
    this.deps.secrets.set({ GOOGLE_OAUTH_PENDING: JSON.stringify(pending) }, new Date(this.deps.now()));
    const state = this.deps.files.state();
    this.deps.files.writeState({ ...state, storage: { ...state.storage, phase: "CONNECTING", error: undefined } });
    return {
      configured: true,
      authorizationUrl: authorizationUrl(config, pending),
      summary: "Google Drive is connected to me. Tour Core also needs permission to save its records there directly so tours keep working even when I'm not in this chat. I'll open Google's approval screen for that now.",
      grok:
        "Use Grok's built-in Google Drive connector if it is not already connected (grok.com/connectors, or Grok Bot Marketplace / Settings → Plugins). Do not ask for a Google password, API key, or client secret. Then open authorizationUrl for the operator to approve Tour Core's own access. That second approval is required: xAI does not document a way for Tour Core to use the connector's token. Never put tokens in chat.",
    };
  }

  async completeCallback(query: URLSearchParams): Promise<{ ok: boolean; summary: string }> {
    if (this.model() === "HOSTED_P0_VOLUME") return { ok: false, summary: "Hosted Tour Core does not use a separate Google approval." };
    const pending = this.pending();
    try {
      checkState(pending, query.get("state") ?? undefined, this.deps.now());
    } catch (err) {
      return { ok: false, summary: err instanceof Error ? err.message : "That Google approval didn't match." };
    }
    if (query.get("error")) return { ok: false, summary: "Google Drive wasn't approved. Nothing was connected." };
    const code = query.get("code") ?? "";
    const config = googleClientConfig(this.deps.env(), (name) => this.deps.secrets.get(name as SettingName));
    const token = await exchangeCode(config, pending!, code, this.deps.fetch());
    const email = await googleEmail(token.accessToken, this.deps.fetch()).catch(() => undefined);
    const now = new Date(this.deps.now());
    this.deps.secrets.set(
      {
        ...(token.refreshToken ? { GOOGLE_OAUTH_REFRESH_TOKEN: token.refreshToken } : {}),
        GOOGLE_OAUTH_ACCESS_TOKEN: token.accessToken,
        GOOGLE_OAUTH_ACCESS_EXPIRES_AT: String(token.expiresAt),
      },
      now,
    );
    this.deps.secrets.delete(["GOOGLE_OAUTH_PENDING"], now);
    const state = this.deps.files.state();
    this.deps.files.writeState({ ...state, storage: { ...state.storage, phase: "CONNECTING", ...(email ? { accountEmail: email } : {}), error: undefined } });
    return { ok: true, summary: "Google approved Tour Core. I'll finish saving the Tour Core folder." };
  }

  async finish(): Promise<{ ok: boolean; summary: string; folderId?: string; folderName?: string }> {
    if (this.model() === "HOSTED_P0_VOLUME") {
      return { ok: false, summary: "Hosted Tour Core keeps operational records on its own store. Confirm the Google Drive backup folder instead." };
    }
    if (!this.refreshToken()) return { ok: false, summary: "Google hasn't approved Tour Core yet." };
    const client = await this.client();
    const storeId = this.ensureHost().storeId;
    const remote = await GoogleDriveStore.open(client, "Tour Core", storeId);
    this.remote = remote;
    const identity = this.ensureHost();
    await claimLease(remote, { ...identity, storeId }, this.deps.now(), LEASE_TTL_MS, false);
    const now = new Date(this.deps.now());
    this.deps.files.update({ storageProvider: "GOOGLE_DRIVE" }, now);
    const state = this.deps.files.state();
    this.deps.files.writeState({
      ...state,
      storage: { ...state.storage, mode: "GOOGLE_DRIVE", phase: "READY", folderId: remote.folderId, folderName: "Tour Core", storeId, chosenAt: now.toISOString(), cacheValidatedAt: now.toISOString(), error: undefined },
    });
    this.cacheValidatedAt = this.deps.now();
    this.audit("GOOGLE_DRIVE_CONNECTED", "Google Drive is the canonical store for this installation.");
    this.audit("STORE_WRITER_ACQUIRED", "This Tour Core computer is the writer for that Google Drive folder.");
    await this.commitLocal();
    return { ok: true, summary: "Tour records: Google Drive connected.", folderId: remote.folderId, folderName: "Tour Core" };
  }

  async probe(): Promise<void> {
    if (this.provider() !== "GOOGLE_DRIVE_READY") return;
    const remote = await this.remoteStore();
    const body = { schemaVersion: 1, at: new Date(this.deps.now()).toISOString() };
    const doc = await remote.put("_probe.json", body, { schemaVersion: 1, kind: "probe" });
    const back = await remote.get("_probe.json");
    await remote.delete("_probe.json", { ifRevision: doc.revision });
    if (back?.sha256 !== doc.sha256) throw new StorageUnavailableError("A test record didn't match.");
    this.cacheValidatedAt = this.deps.now();
  }

  async commitLocal(): Promise<void> {
    if (this.provider() !== "GOOGLE_DRIVE_READY") return;
    if (!this.driveUp()) throw new StorageUnavailableError("I couldn't save that to Google Drive, so it isn't confirmed.");
    const remote = await this.remoteStore();
    const identity = this.ensureHost();
    await claimLease(remote, identity, this.deps.now(), LEASE_TTL_MS, false);
    const files = collectCanonical(this.deps.root, this.secretValues());
    const index = buildLookup(files);
    const extra = [
      ...files.map((file) => ({ path: file.path, body: file.body, schemaVersion: 1, kind: file.kind })),
      { path: "indexes/lookup.json", body: index, schemaVersion: 1, kind: "index" },
      { path: "exports/property-summary.json", body: { schemaVersion: 1, role: "export", properties: index.properties, generatedAt: new Date(this.deps.now()).toISOString() }, schemaVersion: 1, kind: "export" },
      { path: "exports/tour-history.csv.json", body: { schemaVersion: 1, role: "export", csv: tourHistoryCsv(index) }, schemaVersion: 1, kind: "export" },
    ];
    for (const doc of extra) {
      const existing = await remote.get(doc.path);
      if (existing && JSON.stringify(existing.body) === JSON.stringify(doc.body)) continue;
      await remote.put(doc.path, doc.body, { schemaVersion: 1, kind: doc.kind, ...(existing ? { ifRevision: existing.revision } : {}) });
    }
    this.cacheValidatedAt = this.deps.now();
    const state = this.deps.files.state();
    this.deps.files.writeState({ ...state, storage: { ...state.storage, cacheValidatedAt: new Date(this.deps.now()).toISOString() } });
  }

  prepare(now = new Date(this.deps.now())): MigrationProgress {
    this.requireDirectDrive();
    const progress = prepareMigration(this.deps.root, now, this.secretValues());
    this.writeMigration(progress);
    this.audit("STORAGE_MIGRATION_STARTED", "Copying tour records to Google Drive.");
    return progress;
  }

  async migrate(): Promise<MigrationProgress> {
    this.requireDirectDrive();
    const progress = this.deps.files.state().storage?.migration ?? this.prepare();
    const remote = await this.remoteStore();
    try {
      const next = await copyMigration(remote, this.deps.root, progress, this.secretValues(), new Date(this.deps.now()));
      this.writeMigration(next);
      return next;
    } catch (err) {
      const failed: MigrationProgress = { ...progress, phase: "FAILED", error: "The copy to Google Drive stopped. Records are still stored on this computer.", updatedAt: new Date(this.deps.now()).toISOString() };
      this.writeMigration(failed);
      this.audit("STORAGE_MIGRATION_FAILED", failed.error!);
      throw err;
    }
  }

  async verify(): Promise<MigrationProgress> {
    this.requireDirectDrive();
    const progress = this.migration();
    const next = await verifyMigration(await this.remoteStore(), progress, new Date(this.deps.now()));
    this.writeMigration(next);
    if (next.phase === "FAILED") this.audit("STORAGE_MIGRATION_FAILED", next.error ?? "The copy didn't match.");
    return next;
  }

  async activate(): Promise<{ summary: string }> {
    this.requireDirectDrive();
    const progress = this.migration();
    if (progress.phase !== "VERIFIED") throw new StorageUnavailableError("Google Drive isn't the canonical store until the copy has been checked.");
    const finished = await this.finish();
    const done: MigrationProgress = { ...progress, phase: "ACTIVATED", updatedAt: new Date(this.deps.now()).toISOString() };
    this.writeMigration(done);
    this.audit("STORAGE_MIGRATION_COMPLETED", "Google Drive is now the canonical store. The local copy was kept.");
    return { summary: finished.summary };
  }

  async discover(): Promise<{ stores: { folderName: string; folderId: string; storeId?: string }[] }> {
    this.requireDirectDrive();
    const client = await this.client();
    const folders = await client.listByAppProperty("tourCoreRole", "store");
    return { stores: folders.map((folder) => ({ folderName: folder.name, folderId: folder.id, ...(folder.appProperties.storeId ? { storeId: folder.appProperties.storeId } : {}) })) };
  }

  async takeover(storeId: string, explicit: boolean): Promise<{ summary: string; tookOver: boolean }> {
    this.requireDirectDrive();
    const client = await this.client();
    const remote = await GoogleDriveStore.open(client, "Tour Core", storeId);
    this.remote = remote;
    const identity = { ...this.ensureHost(), storeId };
    const claimed = await claimLease(remote, identity, this.deps.now(), LEASE_TTL_MS, explicit);
    if (claimed.tookOver) this.audit("STORE_TAKEOVER", claimed.expired ? "The previous writer's lease had expired." : "The operator took over writing this Google Drive folder.");
    else this.audit("STORE_WRITER_ACQUIRED", "This Tour Core computer is the writer for that Google Drive folder.");
    const restored = await restoreCanonical(remote, this.deps.root, this.secretValues());
    const now = new Date(this.deps.now());
    this.deps.files.update({ storageProvider: "GOOGLE_DRIVE" }, now);
    const state = this.deps.files.state();
    this.deps.files.writeState({
      ...state,
      storage: { ...state.storage, mode: "GOOGLE_DRIVE", phase: "READY", folderId: remote.folderId, folderName: "Tour Core", storeId, cacheValidatedAt: now.toISOString(), hostId: identity.writerHostId },
    });
    this.cacheValidatedAt = this.deps.now();
    return { summary: `Restored ${restored.files} records from Google Drive.`, tookOver: claimed.tookOver };
  }

  async disconnect(choice: "local" | "another" | "remain"): Promise<{ summary: string }> {
    this.requireDirectDrive();
    if (choice === "remain") return { summary: "Google Drive stays connected." };
    const remote = this.remote;
    const host = this.deps.files.state().storage?.hostId;
    if (remote && host) await releaseLease(remote, host).catch(() => undefined);
    const refresh = this.refreshToken();
    if (refresh) await revokeToken(refresh, this.deps.fetch()).catch(() => undefined);
    this.deps.secrets.delete(["GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_EXPIRES_AT"], new Date(this.deps.now()));
    const now = new Date(this.deps.now());
    this.deps.files.update({ storageProvider: "LOCAL_DEMO" }, now);
    const state = this.deps.files.state();
    this.deps.files.writeState({
      ...state,
      storage: {
        ...state.storage,
        mode: choice === "local" ? "LOCAL_DEMO" : undefined,
        phase: choice === "another" ? "CONNECTING" : "READY",
        folderId: state.storage?.folderId,
        error: undefined,
      },
    });
    this.remote = undefined;
    this.audit("STORE_WRITER_RELEASED", "This computer stopped writing the Google Drive folder.");
    this.audit("GOOGLE_DRIVE_DISCONNECTED", "Google Drive is no longer the canonical store. Local records were kept, and the Drive folder was not deleted.");
    return {
      summary:
        choice === "local"
          ? "Tour records are stored on this computer again. The Google Drive folder was left in place."
          : "Google Drive is disconnected. Connect the account you want to use next. Nothing in the old folder was deleted.",
    };
  }

  impact(): string {
    return "Disconnecting Google Drive stops Tour Core from saving records there. Live tours need a place to store records. You can move back to this computer, connect a different Google Drive, or stay connected.";
  }

  /** Opens the Drive folder after a restart so later writes don't fall back to memory. */
  async warm(): Promise<void> {
    if (this.provider() === "GOOGLE_DRIVE_READY") await this.remoteStore();
  }

  /**
   * Hosted restart: Drive wins over the local cache, this service keeps its
   * own writer id, and a different live writer is refused. Failure does not
   * fall back to a writable local canonical store.
   */
  async resumeCanonical(): Promise<{ ok: boolean; summary: string }> {
    if (this.model() === "HOSTED_P0_VOLUME") return { ok: true, summary: "Operational records are stored by hosted Tour Core." };
    const provider = this.provider();
    if (provider === "LOCAL_DEMO" || provider === "NOT_CONFIGURED") return { ok: true, summary: provider === "LOCAL_DEMO" ? "local demo" : "storage not configured" };
    if (provider === "GOOGLE_DRIVE_CONNECTING") return { ok: true, summary: "Google Drive is not canonical yet" };
    if (provider !== "GOOGLE_DRIVE_READY") return { ok: false, summary: "Google Drive is canonical but could not be opened. Tour Core will not switch to a local writable store." };
    const keptHost = this.deps.files.state().storage?.hostId;
    try {
      const remote = await this.remoteStore();
      const restored = await restoreCanonical(remote, this.deps.root, this.secretValues());
      const freshHost = keptHost ?? `host_${randomBytes(6).toString("hex")}`;
      const after = this.deps.files.state();
      this.deps.files.writeState({ ...after, storage: { ...after.storage, hostId: freshHost, mode: "GOOGLE_DRIVE", phase: "READY" } });
      const identity = this.ensureHost();
      await claimLease(remote, identity, this.deps.now(), LEASE_TTL_MS, false);
      this.cacheValidatedAt = this.deps.now();
      const state = this.deps.files.state();
      this.deps.files.writeState({ ...state, storage: { ...state.storage, cacheValidatedAt: new Date(this.deps.now()).toISOString(), hostId: identity.writerHostId } });
      this.audit("STORE_WRITER_ACQUIRED", "This Tour Core service is the writer for that Google Drive folder.");
      return { ok: true, summary: `Google Drive canonical (${restored.files} records restored)` };
    } catch (err) {
      if (err instanceof StoreBusyError) {
        return { ok: false, summary: "Another Tour Core is still writing this Google Drive folder. Take over the writer before this hosted service starts. Local files will not be treated as canonical." };
      }
      return { ok: false, summary: "Google Drive is canonical but could not be opened. Tour Core will not switch to a local writable store." };
    }
  }

  private migration(): MigrationProgress {
    const progress = this.deps.files.state().storage?.migration;
    if (!progress) throw new StorageUnavailableError("Prepare the copy to Google Drive first.");
    return progress;
  }

  private writeMigration(progress: MigrationProgress): void {
    const state = this.deps.files.state();
    this.deps.files.writeState({ ...state, storage: { ...state.storage, phase: "MIGRATING", migration: progress } });
  }

  private async remoteStore(): Promise<GoogleDriveStore> {
    if (this.remote) return this.remote;
    const state = this.deps.files.state().storage;
    this.remote = await GoogleDriveStore.open(await this.client(), state?.folderName ?? "Tour Core", state?.storeId);
    return this.remote;
  }

  private async client(): Promise<DriveClient> {
    if (this.deps.driveClient) return this.deps.driveClient;
    return new HttpDriveClient(async () => {
      const expires = Number(this.deps.secrets.get("GOOGLE_OAUTH_ACCESS_EXPIRES_AT") ?? 0);
      const current = this.deps.secrets.get("GOOGLE_OAUTH_ACCESS_TOKEN");
      if (current && expires > this.deps.now() + 30_000) return current;
      const refresh = this.refreshToken();
      if (!refresh) throw new StorageUnavailableError("Google Drive isn't connected.");
      const config = googleClientConfig(this.deps.env(), (name) => this.deps.secrets.get(name as SettingName));
      const token = await refreshAccess(config, refresh, this.deps.fetch());
      this.deps.secrets.set({ GOOGLE_OAUTH_ACCESS_TOKEN: token.accessToken, GOOGLE_OAUTH_ACCESS_EXPIRES_AT: String(token.expiresAt), ...(token.refreshToken ? { GOOGLE_OAUTH_REFRESH_TOKEN: token.refreshToken } : {}) }, new Date(this.deps.now()));
      return token.accessToken;
    }, this.deps.fetch() as never);
  }

  private refreshToken(): string | undefined {
    return this.deps.secrets.get("GOOGLE_OAUTH_REFRESH_TOKEN");
  }

  private pending(): OAuthPending | undefined {
    const raw = this.deps.secrets.get("GOOGLE_OAUTH_PENDING");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthPending;
    } catch {
      return undefined;
    }
  }

  private ensureHost(): { storeId: string; writerHostId: string; installationId: string } {
    const state = this.deps.files.state();
    const installationId = this.deps.files.readableManifest()?.installationId ?? "inst_local";
    const storeId = state.storage?.storeId ?? `store_${randomBytes(6).toString("hex")}`;
    const writerHostId = state.storage?.hostId ?? `host_${randomBytes(6).toString("hex")}`;
    if (state.storage?.storeId !== storeId || state.storage?.hostId !== writerHostId) {
      this.deps.files.writeState({ ...state, storage: { ...state.storage, storeId, hostId: writerHostId } });
    }
    return { storeId, writerHostId, installationId };
  }

  private audit(type: Parameters<typeof appendStorageAudit>[1]["type"], detail: string): void {
    appendStorageAudit(this.deps.root, { type, at: new Date(this.deps.now()).toISOString(), detail }, this.secretValues());
  }

  private requireDirectDrive(): void {
    if (this.model() === "HOSTED_P0_VOLUME") throw new StorageUnavailableError("Hosted Tour Core does not use Google Drive as its live store. Use a portable backup instead.");
  }

  private secretValues(): string[] {
    return SECRET_SETTING_NAMES.map((name) => this.deps.secrets.get(name)).filter((value): value is string => !!value);
  }
}
