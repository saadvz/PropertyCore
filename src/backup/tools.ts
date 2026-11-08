import { z } from "zod";
import { PortableBackupError } from "../backup/portable";
import type { OperatorTool } from "../operator/tools";
import { tool } from "../operator/defineTool";
import { SetupInputError } from "../setup/setupActions";
import type { Installation } from "../install/installation";

function installation(ctx: { installation?: Installation }): Installation {
  if (!ctx.installation) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  return ctx.installation;
}

function plain(err: unknown): never {
  if (err instanceof PortableBackupError || err instanceof SetupInputError) throw err;
  throw new SetupInputError("BACKUP_FAILED", err instanceof Error ? err.message : "The backup couldn't be completed.");
}

const Code = z.string().trim().min(4).max(12).optional();

export const BACKUP_TOOLS: OperatorTool[] = [
  tool({
    name: "confirm_backup_destination",
    title: "Confirm Google Drive backups",
    kind: "change",
    description:
      "After Grok's native Google Drive connector is connected and the private Tour Core folder exists, record that portable backups go there. provider is google_drive. folderName is Tour Core. No tokens, client ids, or secrets.",
    input: z.strictObject({
      provider: z.literal("google_drive"),
      folderName: z.string().min(1).max(80),
      accountLabel: z.string().trim().min(1).max(80).optional(),
    }),
    run: async (ctx, input) => {
      try {
        return installation(ctx).backups.confirmDestination(input);
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "decline_portable_backup",
    title: "Skip portable backups",
    kind: "change",
    description:
      "Records that the operator declined Google Drive backups for now. On a hosted install, say \"Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.\" When records are already on this computer, or Google Drive is still waiting for approval, say \"Your records stay on this computer. Portable backups stay off until Google Drive is connected.\"",
    input: z.strictObject({}),
    run: async (ctx) => installation(ctx).backups.decline(),
  }),
  tool({
    name: "get_backup_status",
    title: "Portable backup status",
    kind: "read",
    description: "Whether a portable backup is due, and the last non-secret backup metadata. Does not look inside Google Drive.",
    input: z.strictObject({}),
    run: async (ctx) => installation(ctx).backups.status(),
  }),
  tool({
    name: "create_portable_backup",
    title: "Create a portable backup",
    kind: "change",
    description:
      "Builds a validated, secret-free portable snapshot and a short-lived download for you to save in Google Drive. The summary is safe to say. The handoff is for you only. A failed backup does not affect a live tour.",
    input: z.strictObject({ reason: z.enum(["operator", "publish", "content", "tour", "routine"]).optional() }),
    run: async (ctx, input) => {
      try {
        return installation(ctx).backups.create(input.reason);
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "confirm_backup_stored",
    title: "Confirm a backup was saved",
    kind: "change",
    description: "After you have uploaded the backup to Google Drive and confirmed the file is there, record that. Tour Core does not see Drive itself. Pass the file name and checksum from create_portable_backup. No links.",
    input: z.strictObject({
      fileName: z.string().min(8).max(120),
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    run: async (ctx, input) => {
      try {
        return installation(ctx).backups.confirmStored(input);
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "create_readable_export",
    title: "Create a readable export",
    kind: "change",
    description: "A human-readable export, separate from a restorable backup. Short-lived download for you to save under Tour Core/Exports. Not a backup.",
    input: z.strictObject({}),
    run: async (ctx) => {
      try {
        return installation(ctx).backups.createExport();
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "begin_restore_upload",
    title: "Start a backup restore",
    kind: "change",
    description: "Opens a short-lived upload for one portable backup. Nothing is imported until the operator approves a preview. Do not paste the backup into chat. Upload the file to the handoff. A backup up to 50 MB is accepted. An upload over that cap is refused with a message that states the cap. Every expired upload says to send the file again. Start a new upload with begin_restore_upload.",
    input: z.strictObject({}),
    run: async (ctx) => installation(ctx).backups.beginRestore(),
  }),
  tool({
    name: "preview_portable_restore",
    title: "Preview a backup",
    kind: "read",
    description: "Checks an uploaded portable backup and returns a plain preview. Does not change operational records. Every expired upload says to send the file again, including a second look and a file that arrived before the link expired. Upload the backup file first is only for a live link with no file. Start a new upload with begin_restore_upload.",
    input: z.strictObject({ uploadId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/) }),
    run: async (ctx, input) => {
      try {
        return installation(ctx).backups.preview(input.uploadId);
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "import_portable_backup",
    title: "Restore a portable backup",
    kind: "consequential",
    description:
      "After a preview, restores business records. Asks once. If this Tour Core already has records, pass recovery replace only after the operator explicitly chooses replacement. Does not restore provider credentials. Does not merge two installations. An older ID check is named in the import summary: it now uses the basic identity form, and the landlord can ask for no form. Every expired upload says to send the file again. Start a new upload with begin_restore_upload.",
    input: z.strictObject({
      uploadId: z.string().regex(/^art_[A-Za-z0-9_-]{20,80}$/),
      recovery: z.enum(["replace"]).optional(),
      confirmationCode: Code,
    }),
    run: async (ctx, input) => {
      const inst = installation(ctx);
      try {
        const preview = inst.backups.preview(input.uploadId);
        if (preview.replaceRequired && input.recovery !== "replace") {
          return { summary: "This Tour Core already has records. Restoring would replace them. Nothing was changed.", replaceRequired: true };
        }
        const fingerprint = `${input.uploadId}:${input.recovery ?? "restore"}:${String(preview.checksum)}`;
        const question = preview.replaceRequired
          ? "Replace the records on this Tour Core with this backup? Logins for texting and updates are not in the backup."
          : "Restore this backup onto this Tour Core? Logins for texting and updates are not in the backup.";
        if (!input.confirmationCode) {
          const issued = ctx.confirmations.issue("import-backup", input.uploadId, fingerprint, question);
          return { summary: issued.question, confirmationCode: issued.code, requiresConfirmation: true, lines: preview.lines };
        }
        ctx.confirmations.redeem(input.confirmationCode, "import-backup", input.uploadId, fingerprint);
        return inst.backups.importBackup(input.uploadId, input.recovery);
      } catch (err) {
        plain(err);
      }
    },
  }),
];
