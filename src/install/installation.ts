import { GrokRoutineWebhookSink, NoopOperatorNotificationSink, type OperatorEvent, type OperatorNotificationSink } from "../alerts/operatorEvents";
import { OperatorEventOutbox, type OutboxOptions } from "../alerts/outbox";
import { OAuthGrantStore } from "../mcp/oauth/store";
import { sendblueRuntime, type SendblueEnv } from "../messaging/sendblue/runtime";
import { PortableBackups } from "../backup/service";
import type { RuntimeStore } from "../storage/runtimeStore";
import type { DriveClient } from "../storage/googleDrive";
import { RecordStore } from "../storage/recordStore";
import { ApprovalSessions } from "./approvalSessions";
import { resolveDeploymentMode, type DeploymentMode } from "./deployment";
import { InstallationFiles } from "./manifest";
import { LocalSecretStore, type SecretStore, type SettingName } from "./secretStore";
import { effectiveEnv, secretValues, settingSource, type SettingsSource } from "./settings";
import { SetupSessions } from "./setupSessions";

export const TOURCORE_VERSION = "0.4.0";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface InstallationOptions {
  /** The Tour Core data folder (TOURCORE_HOME, default ./tourcore-data). */
  root: string;
  runtime: RuntimeStore;
  secrets?: SecretStore;
  /** The raw environment. Defaults to process.env. */
  env?: () => NodeJS.ProcessEnv;
  /** Sendblue settings as the adapters see them. Defaults to the shared Sendblue runtime. */
  sendblueEnv?: () => SendblueEnv;
  now?: () => number;
  /** Network access for endpoint checks and routine deliveries. Tests replace it. */
  fetch?: Fetch;
  outbox?: Omit<OutboxOptions, "now" | "stillRelevant">;
  log?: (line: string) => void;
  /** Tests inject a fake Drive. Production uses Google's HTTP API. */
  driveClient?: DriveClient;
  /** Where operator events go instead of the Grok Routine. A touring process on the shared service relays them. */
  notificationSink?: () => OperatorNotificationSink;
}

/**
 * One Tour Core installation: its manifest, provider settings, secure setup
 * sessions and operator alert outbox. Shared by the running server, the
 * installation tools Grok calls, and the bootstrap. It holds no tour state;
 * properties, tours and exceptions stay in the workspace.
 */
export class Installation {
  readonly files: InstallationFiles;
  readonly secrets: SecretStore;
  readonly sessions: SetupSessions;
  readonly approvals: ApprovalSessions;
  readonly outbox: OperatorEventOutbox;
  readonly grants: OAuthGrantStore;
  readonly records: RecordStore;
  readonly backups: PortableBackups;
  readonly startedAt: number;
  private relevance?: (event: OperatorEvent) => Promise<boolean>;

  constructor(readonly options: InstallationOptions) {
    const now = options.now ?? Date.now;
    this.secrets = options.secrets ?? new LocalSecretStore(new InstallationFiles(options.root).paths.secrets, now);
    this.files = new InstallationFiles(options.root, () => secretValues(this.rawEnv(), { secrets: this.secrets }));
    this.sessions = new SetupSessions(options.runtime, now);
    this.approvals = new ApprovalSessions(options.runtime, now);
    this.grants = new OAuthGrantStore(options.runtime, now);
    this.outbox = new OperatorEventOutbox(options.runtime, () => this.sink(), {
      ...options.outbox,
      now,
      log: options.log,
      stillRelevant: (event) => this.relevance?.(event) ?? Promise.resolve(true),
    });
    this.startedAt = now();
    this.records = new RecordStore({
      root: options.root,
      now: () => this.now(),
      deploymentMode: () => this.deploymentMode(),
      files: this.files,
      secrets: this.secrets,
      publicBaseUrl: () => this.publicBaseUrl(),
      env: () => this.env(),
      fetch: () => this.fetch(),
      driveClient: options.driveClient,
    });
    this.backups = new PortableBackups(this, TOURCORE_VERSION);
  }

  get root(): string {
    return this.options.root;
  }

  get runtime(): RuntimeStore {
    return this.options.runtime;
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  fetch(): Fetch {
    return this.options.fetch ?? ((url, init) => fetch(url, init));
  }

  private rawEnv(): NodeJS.ProcessEnv {
    return this.options.env?.() ?? process.env;
  }

  settingsSource(): SettingsSource {
    return { secrets: this.secrets, manifest: () => this.files.manifest(), deploymentMode: () => this.deploymentMode() };
  }

  /** Environment plus secure-setup values plus the manifest's public address. */
  env(): NodeJS.ProcessEnv {
    return effectiveEnv(this.rawEnv(), this.settingsSource());
  }

  deploymentMode(): DeploymentMode {
    return this.deployment().mode;
  }

  deployment() {
    let recorded: DeploymentMode | undefined;
    try {
      recorded = this.files.manifest()?.deploymentMode;
    } catch {
      recorded = undefined;
    }
    return resolveDeploymentMode(this.rawEnv(), recorded);
  }

  sendblueEnv(): SendblueEnv {
    return (this.options.sendblueEnv ?? sendblueRuntime.env)();
  }

  publicBaseUrl(): string | undefined {
    return this.sendblueEnv().publicBaseUrl;
  }

  settingSource(name: SettingName) {
    return settingSource(name, this.rawEnv(), { secrets: this.secrets });
  }

  /** Where operator events go: the Grok Routine once its address and key are set, otherwise nowhere yet. */
  sink(): OperatorNotificationSink {
    if (this.options.notificationSink) return this.options.notificationSink();
    const env = () => this.env();
    const routine = new GrokRoutineWebhookSink(
      { url: () => env().TOURCORE_GROK_ROUTINE_URL?.trim() || undefined, key: () => env().TOURCORE_GROK_ROUTINE_KEY?.trim() || undefined },
      { fetch: this.options.fetch as never },
    );
    return routine.configured() ? routine : new NoopOperatorNotificationSink();
  }

  /** The server tells the outbox how to recognise an event that no longer matters (its exception was handled). */
  setRelevanceCheck(check: (event: OperatorEvent) => Promise<boolean>): void {
    this.relevance = check;
  }
}
