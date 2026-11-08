import type { InstallationFiles } from "../install/manifest";
import type { SecretStore } from "../install/secretStore";
import { secretValues } from "../install/settings";
import { collectCanonical } from "../storage/canonical";
import { HandoffError, HandoffStore, UPLOAD_BACKUP_FIRST } from "./handoff";
import { RestoreUploadTooLargeError } from "./limits";
import {
  PortableBackupError,
  applyPortableBackup,
  backupFileName,
  buildPortableBackup,
  buildReadableExport,
  countBackup,
  hasLiveBusinessState,
  parsePortableBackup,
  previewLines,
  reconnectLines,
  type PortableBackup,
} from "./portable";

export interface BackupDestinationInput {
  provider: "google_drive";
  folderName: string;
  accountLabel?: string;
}

const HOSTED_DECLINE = "Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.";
const SELF_HOST_DECLINE = "Your records stay on this computer. Portable backups stay off until Google Drive is connected.";

const GROK_NOTE = "For you only. Do not show this link or capability to the operator. Download it once, save it with the Google Drive connector, then tell Tour Core it was stored. The link expires and is not a public backup address.";
const RESTORE_NOTE = "For you only. Do not show this link or capability to the operator. Upload the backup file once to this address. Then ask Tour Core to check it before anything changes. The link expires and is not a public restore address. A backup up to 50 MB is accepted. Every expired upload says to send the file again. Start a new upload with restore_records, action upload.";

/**
 * Portable backups for HOSTED_RAILWAY_P0. The Railway volume stays the live
 * store. This service never calls Google and never decides access.
 */
export interface BackupHost {
  root: string;
  now(): number;
  env(): NodeJS.ProcessEnv;
  files: InstallationFiles;
  secrets: SecretStore;
  /** Present on a running installation. Absent only for a narrow test double. */
  records?: { provider(): string };
}

export class PortableBackups {
  readonly handoff: HandoffStore;

  constructor(
    private readonly inst: BackupHost,
    private readonly version: string,
  ) {
    this.handoff = new HandoffStore(inst.root, () => inst.now());
  }

  private secrets(): string[] {
    return secretValues(this.inst.env(), { secrets: this.inst.secrets });
  }

  private installationId(): string {
    return this.inst.files.manifest()?.installationId ?? "inst_unknown";
  }

  confirmDestination(input: BackupDestinationInput): { summary: string } {
    if (input.provider !== "google_drive") throw new PortableBackupError("Portable backups use Google Drive through Grok.");
    if (input.folderName.trim() !== "Tour Core") throw new PortableBackupError("The backup folder should be named Tour Core.");
    const label = input.accountLabel?.trim();
    if (label && (label.length > 80 || /[\r\n]/.test(label) || label.includes("://"))) {
      throw new PortableBackupError("That account label isn't something Tour Core can store.");
    }
    const text = JSON.stringify(input);
    if (this.secrets().some((secret) => secret.length >= 6 && text.includes(secret))) {
      throw new PortableBackupError("Don't send credentials with the backup destination.");
    }
    const now = new Date(this.inst.now()).toISOString();
    const state = this.inst.files.state();
    this.inst.files.writeState({
      ...state,
      portableBackup: {
        ...state.portableBackup,
        declinedAt: undefined,
        destination: { provider: "google_drive", folderName: "Tour Core", ...(label ? { accountLabel: label } : {}), configuredAt: now },
      },
    });
    return { summary: "Google Drive is connected. I've prepared your Tour Core folder." };
  }

  decline(): { summary: string } {
    const state = this.inst.files.state();
    if (state.portableBackup?.destination) return { summary: "Google Drive backups are already connected." };
    const now = new Date(this.inst.now()).toISOString();
    this.inst.files.writeState({ ...state, portableBackup: { ...state.portableBackup, declinedAt: now } });
    return { summary: this.declineSummary() };
  }

  /** Hosted installs keep the hosted line. Local records, or a Drive approval still open, stay on this computer. */
  private declineSummary(): string {
    const provider = this.inst.records?.provider();
    if (provider === "LOCAL_DEMO" || provider === "GOOGLE_DRIVE_CONNECTING") return SELF_HOST_DECLINE;
    return HOSTED_DECLINE;
  }

  create(reason?: string): Record<string, unknown> {
    try {
      const createdAt = new Date(this.inst.now()).toISOString();
      const backup = buildPortableBackup({
        root: this.inst.root,
        installationId: this.installationId(),
        createdAt,
        tourCoreVersion: this.version,
        secretValues: this.secrets(),
      });
      const text = JSON.stringify(backup, null, 2) + "\n";
      const fileName = backupFileName(createdAt);
      const issued = this.handoff.putDownload(text, fileName, backup.checksum);
      const state = this.inst.files.state();
      this.inst.files.writeState({
        ...state,
        portableBackup: {
          ...state.portableBackup,
          lastBackupCreatedAt: createdAt,
          lastBackupChecksum: backup.checksum,
          lastBackupSchemaVersion: backup.schemaVersion,
          lastBackupFileName: fileName,
          lastFailureAt: undefined,
          lastFailureSummary: undefined,
        },
      });
      const counts = countBackup(backup);
      return {
        summary: "A portable backup is ready. Save it in Google Drive under Tour Core, Backups.",
        fileName,
        checksum: backup.checksum,
        schemaVersion: backup.schemaVersion,
        bytes: Buffer.byteLength(text),
        expiresAt: issued.expiresAt,
        counts,
        ...(reason ? { reason } : {}),
        handoff: { note: GROK_NOTE, method: "GET", path: issued.path, capability: issued.capability },
      };
    } catch (err) {
      const summary = err instanceof PortableBackupError ? err.message : "The backup couldn't be created.";
      this.noteFailure(summary);
      throw err instanceof PortableBackupError ? err : new PortableBackupError(summary);
    }
  }

  confirmStored(input: { fileName: string; checksum: string }): { summary: string } {
    const state = this.inst.files.state();
    const meta = state.portableBackup;
    if (!meta?.lastBackupChecksum || meta.lastBackupChecksum !== input.checksum || meta.lastBackupFileName !== input.fileName) {
      throw new PortableBackupError("That doesn't match the backup Tour Core created. Nothing was marked as stored.");
    }
    const now = new Date(this.inst.now()).toISOString();
    this.inst.files.writeState({
      ...state,
      portableBackup: { ...meta, lastBackupConfirmedInDriveAt: now, lastFailureAt: undefined, lastFailureSummary: undefined },
    });
    return { summary: "Recorded that this backup is stored in Google Drive." };
  }

  status(): Record<string, unknown> {
    const meta = this.inst.files.state().portableBackup;
    const due = this.due();
    const failed = !!meta?.lastFailureAt && (!meta.lastBackupConfirmedInDriveAt || meta.lastFailureAt > meta.lastBackupConfirmedInDriveAt);
    const connected = !!meta?.destination;
    const portable = connected ? "Google Drive connected" : "not connected";
    return {
      summary: `Operational records: Stored by hosted Tour Core. Portable backup: ${portable}.`,
      operationalStore: "HOSTED_P0_VOLUME",
      portableBackup: connected ? "CONNECTED" : "NOT_CONNECTED",
      ...(meta?.destination?.folderName ? { folderName: meta.destination.folderName } : {}),
      ...(meta?.destination?.accountLabel ? { accountLabel: meta.destination.accountLabel } : {}),
      ...(meta?.lastBackupCreatedAt ? { lastBackupCreatedAt: meta.lastBackupCreatedAt } : {}),
      ...(meta?.lastBackupConfirmedInDriveAt ? { lastBackupConfirmedInDriveAt: meta.lastBackupConfirmedInDriveAt } : {}),
      ...(meta?.lastBackupChecksum ? { lastBackupChecksum: meta.lastBackupChecksum } : {}),
      ...(meta?.lastBackupSchemaVersion ? { lastBackupVersion: meta.lastBackupSchemaVersion } : {}),
      due: due.due,
      dueReasons: due.reasons,
      stale: due.due || failed,
      ...(failed && meta?.lastFailureSummary ? { lastFailureSummary: meta.lastFailureSummary, lastFailureAt: meta.lastFailureAt } : {}),
    };
  }

  due(): { due: boolean; reasons: string[] } {
    const confirmed = this.inst.files.state().portableBackup?.lastBackupConfirmedInDriveAt;
    const reasons: string[] = [];
    const newer = (at: string | undefined, reason: string) => {
      if (!at) return;
      if (!confirmed || at > confirmed) reasons.push(reason);
    };
    for (const file of collectCanonical(this.inst.root, this.secrets())) {
      if (file.path.endsWith("/status.json")) {
        const publishedAt = (file.body as { publishedAt?: string; status?: string }).publishedAt;
        if ((file.body as { status?: string }).status === "PUBLISHED_FOR_DEMO") newer(publishedAt, "after a property was published");
      }
      if (file.path.endsWith("/content-changes.json")) {
        const changes = (file.body as { changes?: { at?: string }[] }).changes ?? [];
        const last = changes.map((change) => change.at).filter((at): at is string => !!at).sort().at(-1);
        newer(last, "after an approved content change");
      }
      if (file.path.endsWith("/record.json")) {
        const body = file.body as { outcome?: string; updatedAt?: string; ranAt?: string };
        if (body.outcome === "finished" || body.outcome === "passed" || body.outcome === "completed") newer(body.updatedAt ?? body.ranAt, "after a completed tour");
      }
    }
    return { due: reasons.length > 0, reasons: [...new Set(reasons)] };
  }

  createExport(): Record<string, unknown> {
    const createdAt = new Date(this.inst.now()).toISOString();
    const exported = buildReadableExport({ root: this.inst.root, installationId: this.installationId(), createdAt, secretValues: this.secrets() });
    const issued = this.handoff.putDownload(exported.text, exported.fileName, "export");
    return {
      summary: "A readable export is ready. Save it in Google Drive under Tour Core, Exports. This is not a backup.",
      fileName: exported.fileName,
      bytes: Buffer.byteLength(exported.text),
      expiresAt: issued.expiresAt,
      handoff: { note: GROK_NOTE, method: "GET", path: issued.path, capability: issued.capability },
    };
  }

  beginRestore(): Record<string, unknown> {
    const issued = this.handoff.beginUpload();
    return {
      summary: "Send the backup file to Tour Core. I'll check it before anything changes.",
      expiresAt: issued.expiresAt,
      handoff: { note: RESTORE_NOTE, method: "POST", path: issued.path, capability: issued.capability },
    };
  }

  receive(id: string, capability: string, body: string): void {
    try {
      this.handoff.receiveUpload(id, capability, body);
    } catch (err) {
      this.rethrowReceive(err);
    }
  }

  /** Moves a spooled upload into the handoff. Does not import it. */
  receiveFile(id: string, capability: string, filePath: string): void {
    try {
      this.handoff.acceptUploadFile(id, capability, filePath);
    } catch (err) {
      this.rethrowReceive(err);
    }
  }

  private rethrowReceive(err: unknown): never {
    if (err instanceof RestoreUploadTooLargeError) throw err;
    if (err instanceof HandoffError) throw new PortableBackupError(err.message);
    throw err;
  }

  preview(uploadId: string): Record<string, unknown> {
    const backup = this.uploaded(uploadId);
    const lines = previewLines(backup, this.installationId());
    const live = hasLiveBusinessState(this.inst.root);
    return {
      summary: lines.join("\n"),
      lines,
      counts: countBackup(backup),
      installationId: backup.installationId,
      sameInstallation: backup.installationId === this.installationId(),
      replaceRequired: live,
      schemaVersion: backup.schemaVersion,
      checksum: backup.checksum,
    };
  }

  importBackup(uploadId: string, recovery?: "replace"): { summary: string; lines: string[] } {
    const backup = this.uploaded(uploadId);
    const live = hasLiveBusinessState(this.inst.root);
    if (live && recovery !== "replace") {
      throw new PortableBackupError("This Tour Core already has records. Restoring would replace them, and that needs an explicit recovery choice. Nothing was changed.");
    }
    const restored = applyPortableBackup(this.inst.root, backup, live);
    this.handoff.consumeUpload(uploadId);
    const lines = reconnectLines({
      texting: !!this.inst.secrets.get("SENDBLUE_API_API_KEY"),
      updates: !!this.inst.secrets.get("TOURCORE_GROK_ROUTINE_KEY"),
    });
    lines.push(...restored.notes);
    return { summary: lines.join(" "), lines };
  }

  noteFailure(summary: string): void {
    const state = this.inst.files.state();
    this.inst.files.writeState({
      ...state,
      portableBackup: { ...state.portableBackup, lastFailureAt: new Date(this.inst.now()).toISOString(), lastFailureSummary: summary },
    });
  }

  private uploaded(uploadId: string): PortableBackup {
    let raw: string;
    try {
      raw = this.handoff.readUpload(uploadId);
    } catch (err) {
      throw new PortableBackupError(err instanceof HandoffError ? err.message : UPLOAD_BACKUP_FIRST);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PortableBackupError("That file isn't a Tour Core backup.");
    }
    return parsePortableBackup(parsed, this.secrets());
  }
}
