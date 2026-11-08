import { z } from "zod";
import type { OperatorTool } from "../operator/tools";
import { tool } from "../operator/defineTool";
import { SetupInputError } from "../setup/setupActions";
import { StoreBusyError, StorageConflictError, StorageUnavailableError } from "../storage/errors";
import type { Installation } from "./installation";

function installation(ctx: { installation?: Installation }): Installation {
  if (!ctx.installation) throw new SetupInputError("INSTALLATION_UNAVAILABLE", "Installation tools aren't available on this Tour Core.");
  return ctx.installation;
}

function plain(err: unknown): never {
  if (err instanceof StoreBusyError || err instanceof StorageConflictError || err instanceof StorageUnavailableError || err instanceof SetupInputError) throw err;
  throw new SetupInputError("STORAGE_FAILED", err instanceof Error ? err.message : "Google Drive couldn't do that.");
}

const Code = z.string().trim().min(4).max(12).optional();

export const STORAGE_TOOLS: OperatorTool[] = [
  tool({
    name: "get_storage_status",
    title: "Where tour records are kept",
    kind: "read",
    description: "Whether tour records are stored on this computer or in Google Drive, and whether a copy or connection is in progress. Never returns tokens.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const records = installation(ctx).records;
      const location = records.location();
      return { summary: records.summary(), ...location };
    },
  }),
  tool({
    name: "get_storage_location",
    title: "Tour Core folder",
    kind: "read",
    description: "The Google Drive folder name and id when Drive is connected, so you can open it with the Google Drive connector. Never returns tokens.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const location = installation(ctx).records.location();
      return { summary: location.description, ...location };
    },
  }),
  tool({
    name: "begin_google_drive_connect",
    title: "Start Google Drive",
    kind: "change",
    description:
      "Starts Tour Core's own Google approval. If Grok's Google Drive connector is not connected, connect that first without asking for a password. Then open authorizationUrl. If the Google app is not configured, tell the operator the summary and offer to keep records on this computer. Never ask them to create a Google Cloud project or to paste a credential.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const started = installation(ctx).records.beginConnect();
      if (!started.configured) return { summary: started.summary, configured: false, technical: { note: "For you only.", detail: started.technical } };
      return { summary: started.summary, configured: true, authorizationUrl: started.authorizationUrl, technical: { note: "For you only.", detail: started.grok } };
    },
  }),
  tool({
    name: "finish_google_drive_setup",
    title: "Finish Google Drive",
    kind: "change",
    description: "After the operator approves Google, creates the Tour Core folder and makes Google Drive the canonical store. Call this yourself.",
    input: z.strictObject({}),
    run: async (ctx) => {
      try {
        return await installation(ctx).records.finish();
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "use_local_demo_storage",
    title: "Keep records on this computer",
    kind: "change",
    description: "Records that the operator declined Google Drive. Tell them the records stay on this computer and are not portable. Only after they say no.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const inst = installation(ctx);
      if (inst.records.model() === "HOSTED_P0_VOLUME") return inst.backups.decline();
      return inst.records.useLocalDemo();
    },
  }),
  tool({
    name: "prepare_storage_migration",
    title: "Prepare a copy to Google Drive",
    kind: "change",
    description: "Counts the local records that would be copied to Google Drive. Does not switch the canonical store.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const progress = installation(ctx).records.prepare();
      return { summary: `I counted ${Object.keys(progress.hashes).length} records to copy. Nothing has moved yet.`, files: Object.keys(progress.hashes).length, phase: progress.phase };
    },
  }),
  tool({
    name: "migrate_storage_to_google_drive",
    title: "Copy records to Google Drive",
    kind: "change",
    description: "Copies canonical records to Google Drive. Safe to run again if a copy was interrupted. Does not switch the canonical store and does not delete the local records.",
    input: z.strictObject({}),
    run: async (ctx) => {
      try {
        const progress = await installation(ctx).records.migrate();
        return { summary: "The copy to Google Drive finished. I'll check it before switching.", phase: progress.phase, files: progress.copied.length };
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "verify_storage_migration",
    title: "Check the Google Drive copy",
    kind: "read",
    description: "Compares the Google Drive copy with the local records. Google Drive does not become canonical until this passes and activate_google_drive_storage is confirmed.",
    input: z.strictObject({}),
    run: async (ctx) => {
      const progress = await installation(ctx).records.verify();
      return { summary: progress.phase === "VERIFIED" ? "The Google Drive copy matches." : "The copy doesn't match yet. Records are still stored on this computer.", phase: progress.phase, ...(progress.error ? { detail: progress.error } : {}) };
    },
  }),
  tool({
    name: "activate_google_drive_storage",
    title: "Use Google Drive as the record store",
    kind: "consequential",
    description: "After the copy has been checked, makes Google Drive the canonical store. Asks once first. Keeps the local copy. Does not delete it.",
    input: z.strictObject({ confirmationCode: Code }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const phase = inst.files.state().storage?.migration?.phase ?? "none";
      if (!i.confirmationCode) {
        const issued = ctx.confirmations.issue("activate-drive", "storage", phase, "The copy checked out. Should I keep tour records in Google Drive from now on?");
        return { summary: issued.question, confirmationCode: issued.code, requiresConfirmation: true };
      }
      ctx.confirmations.redeem(i.confirmationCode, "activate-drive", "storage", phase);
      return inst.records.activate();
    },
  }),
  tool({
    name: "discover_storage",
    title: "Find a Tour Core folder",
    kind: "read",
    description: "Lists Tour Core folders this Google account already has, so a new computer can restore one. Folder name and id only. Never a token.",
    input: z.strictObject({}),
    run: async (ctx) => {
      try {
        const found = await installation(ctx).records.discover();
        return { summary: found.stores.length ? `I found ${found.stores.length} Tour Core folder${found.stores.length === 1 ? "" : "s"}.` : "I didn't find a Tour Core folder in this Google Drive.", ...found };
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "takeover_storage_writer",
    title: "Use an existing Tour Core folder",
    kind: "consequential",
    description:
      "Restores records from an existing Tour Core Google Drive folder onto this computer. If another Tour Core is still writing that folder, asks before taking over. An expired lease can be recovered. Provider secrets are not in Drive and are not restored.",
    input: z.strictObject({ storeId: z.string().min(4).max(80), confirmationCode: Code }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const fingerprint = i.storeId;
      if (!i.confirmationCode) {
        const issued = ctx.confirmations.issue("takeover-drive", i.storeId, fingerprint, "Another Tour Core installation may be using this storage. Should this computer take it over and restore the records?");
        return { summary: issued.question, confirmationCode: issued.code, requiresConfirmation: true };
      }
      ctx.confirmations.redeem(i.confirmationCode, "takeover-drive", i.storeId, fingerprint);
      try {
        return await inst.records.takeover(i.storeId, true);
      } catch (err) {
        plain(err);
      }
    },
  }),
  tool({
    name: "disconnect_google_drive_storage",
    title: "Disconnect Google Drive",
    kind: "consequential",
    description:
      "Disconnects Google Drive. First call explains the impact and asks. choice is local (keep records on this computer), another (connect a different Drive next), or remain (stay connected). Does not delete the Drive folder.",
    input: z.strictObject({ choice: z.enum(["local", "another", "remain"]).optional(), confirmationCode: Code }),
    run: async (ctx, i) => {
      const inst = installation(ctx);
      const names = ctx.services.workspace.list().map((property) => property.config.property.name);
      const fingerprint = names.join(",") || "none";
      if (!i.confirmationCode || !i.choice) {
        const issued = ctx.confirmations.issue("disconnect-drive", "storage", fingerprint, inst.records.impact());
        return { summary: issued.question, confirmationCode: issued.code, requiresConfirmation: true, choices: ["local", "another", "remain"], properties: names };
      }
      ctx.confirmations.redeem(i.confirmationCode, "disconnect-drive", "storage", fingerprint);
      return inst.records.disconnect(i.choice);
    },
  }),
];
