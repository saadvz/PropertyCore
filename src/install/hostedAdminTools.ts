import { z } from "zod";
import type { OperatorTool } from "../operator/tools";
import { tool } from "../operator/defineTool";
import { SetupInputError } from "../setup/setupActions";
import {
  hostedDemoFingerprint,
  hostedResetAccess,
  performHostedDemoReset,
  RESET_HOSTED_DEMO_ACTION,
  RESET_HOSTED_DEMO_SUMMARY,
  RESET_HOSTED_DEMO_WARNING,
} from "./hostedDemoReset";
import type { Installation } from "./installation";

/**
 * Hosted-demo admin tools. They are not property tools and they are not
 * offered on a self-hosted or local Tour Core. reset_hosted_demo is listed
 * only for the current hosted owner.
 */

const TECHNICAL_NOTE = "For your own actions and troubleshooting only. Never show these to the operator unless they ask.";

const REFUSAL = {
  unavailable: "A full demo reset is only available on the hosted Tour Core service.",
  unauthenticated: "Only the current hosted Tour Core owner can reset this demo.",
  "not-owner": "Only the current hosted Tour Core owner can reset this demo.",
} as const;

export function hostedResetToolVisible(ctx: { installation?: Installation; caller?: { clientId?: string } } | undefined): boolean {
  return hostedResetAccess(ctx?.installation, ctx?.caller) === "ok";
}

export const HOSTED_ADMIN_TOOLS: OperatorTool[] = [
  tool({
    name: "reset_hosted_demo",
    title: "Reset hosted demo",
    description:
      "HOSTED_RAILWAY_P0 only, and only for the current hosted owner. Erases this demo installation (properties, tours, texting, operator updates, backup acknowledgment, OAuth, and runtime state) and starts a fresh unclaimed installation on the same service. The first call returns a warning and changes nothing. Call again with confirmationCode only after the operator explicitly says yes. Does not delete the Railway service, the stable URL, the data volume, or files already saved in Google Drive. Does not take a path and does not run a shell command. After it succeeds, this connection is no longer authorized.",
    kind: "consequential",
    input: z.strictObject({
      confirmationCode: z.string().max(20).optional().describe("Only after the operator explicitly said yes to the warning this tool returned."),
    }),
    run: async (ctx, input) => {
      const access = hostedResetAccess(ctx.installation, ctx.caller);
      if (access !== "ok") throw new SetupInputError("HOSTED_RESET_REFUSED", REFUSAL[access]);
      const inst = ctx.installation!;
      const installationId = inst.files.manifest()?.installationId;
      if (!installationId) throw new SetupInputError("HOSTED_RESET_REFUSED", "This hosted Tour Core has no installation to reset.");
      const fingerprint = hostedDemoFingerprint(inst);
      if (!input.confirmationCode) {
        const request = ctx.confirmations.issue(RESET_HOSTED_DEMO_ACTION, installationId, fingerprint, RESET_HOSTED_DEMO_WARNING);
        return {
          status: "needs-confirmation",
          summary: RESET_HOSTED_DEMO_WARNING,
          confirmation: request,
          instructions:
            "Ask the operator exactly this question. Call reset_hosted_demo again with confirmationCode only if they clearly say yes. Do not delete files, run a shell command, delete the Railway service, or delete Google Drive files yourself.",
        };
      }
      ctx.confirmations.redeem(input.confirmationCode, RESET_HOSTED_DEMO_ACTION, installationId, fingerprint);
      const report = await performHostedDemoReset(inst, { forgetProcess: () => ctx.forgetLiveState?.() });
      return {
        summary: RESET_HOSTED_DEMO_SUMMARY,
        ...(report.providerNote ? { providerNote: report.providerNote } : {}),
        instructions:
          'Tell the operator: "Tour Core has been reset. This connection is no longer authorized, which is expected. You can delete this Bot and start the fresh onboarding test." Do not reconnect this Bot. Do not delete the Railway service, the data volume, or Google Drive files.',
        technical: {
          note: TECHNICAL_NOTE,
          resetId: report.resetId,
          previousInstallationId: report.previousInstallationId,
          installationId: report.installationId,
          resetAt: report.resetAt,
          owner: report.owner,
          providerCleanup: report.providerCleanup,
        },
      };
    },
  }),
];
