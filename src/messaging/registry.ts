import type { Installation } from "../install/installation";
import type { InstallationManifest } from "../install/manifest";
import { LocalMessagingProvider, readLocalEnv } from "./local/provider";
import { PhotonMessagingProvider, readPhotonEnv } from "./photon/provider";
import type { MessagingProvider, MessagingProviderId, MessagingProviderInfo, MessagingReadiness } from "./provider";
import { MESSAGING_PROVIDER_IDS } from "./provider";
import { SendblueMessagingProvider, sendblueConfigured } from "./sendblue/provider";
import { sendblueRuntime, type SendblueEnv } from "./sendblue/runtime";
import { TwilioMessagingProvider, readTwilioEnv } from "./twilio/provider";
import type { MessagingLedger } from "./ledger";

export const MESSAGING_PROVIDER_CATALOG: MessagingProviderInfo[] = [
  {
    id: "sendblue",
    displayName: "Sendblue",
    description: "Managed messaging with iMessage/SMS support. Sandbox and dedicated-line behavior may differ.",
  },
  {
    id: "twilio",
    displayName: "Twilio",
    description: "Dedicated SMS messaging with low usage cost. Carrier registration may be required depending on country and use case.",
  },
  {
    id: "photon",
    displayName: "Photon",
    description: "Agent-focused messaging through Photon/Spectrum with iMessage support. Available capabilities depend on the provisioned Photon line/account.",
  },
];

const MANIFEST_PROVIDER: Record<MessagingProviderId, InstallationManifest["messagingProvider"]> = {
  sendblue: "SENDBLUE",
  twilio: "TWILIO",
  photon: "PHOTON",
  local: "LOCAL",
};

let boundInstallation: (() => SelectionInput) | undefined;

/** The running server registers its installation here so readiness and sending use the saved provider. */
export function bindMessagingInstallation(read: () => SelectionInput): () => void {
  const previous = boundInstallation;
  boundInstallation = read;
  return () => {
    if (boundInstallation === read) boundInstallation = previous;
  };
}

export function currentMessagingInput(): SelectionInput {
  return boundInstallation?.() ?? { env: process.env, sendblue: sendblueRuntime.env() };
}

export function isMessagingProviderId(value: string): value is MessagingProviderId {
  return (MESSAGING_PROVIDER_IDS as readonly string[]).includes(value);
}

export function manifestProviderName(id: MessagingProviderId): InstallationManifest["messagingProvider"] {
  return MANIFEST_PROVIDER[id];
}

export interface MessagingSelection {
  provider?: MessagingProviderId;
  invalid?: string;
  /** Valid Sendblue settings existed and no one had chosen another provider. */
  inferredLegacySendblue: boolean;
  readiness: MessagingReadiness;
}

export interface SelectionInput {
  env: NodeJS.ProcessEnv;
  sendblue: SendblueEnv;
  choice?: MessagingProviderId;
  manifestProvider?: InstallationManifest["messagingProvider"];
}

/** Which provider this installation is using. Does not write anything. */
export function resolveMessagingSelection(input: SelectionInput): MessagingSelection {
  const explicit = input.env.TOURCORE_MESSAGING_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!isMessagingProviderId(explicit)) return { invalid: explicit, inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
    return { provider: explicit, inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
  }
  if (input.choice) return { provider: input.choice, inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
  if (input.manifestProvider === "TWILIO") return { provider: "twilio", inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
  if (input.manifestProvider === "PHOTON") return { provider: "photon", inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
  if (input.manifestProvider === "LOCAL") return { provider: "local", inferredLegacySendblue: false, readiness: "NEEDS_ACTION" };
  if (sendblueConfigured(input.sendblue)) {
    return { provider: "sendblue", inferredLegacySendblue: true, readiness: "NEEDS_ACTION" };
  }
  return { inferredLegacySendblue: false, readiness: "NOT_CONFIGURED" };
}

export function selectionFromInstallation(inst: Installation): MessagingSelection {
  let manifestProvider: InstallationManifest["messagingProvider"] | undefined;
  try {
    manifestProvider = inst.files.manifest()?.messagingProvider;
  } catch {
    manifestProvider = undefined;
  }
  const choice = inst.files.state().messagingProviderChoice;
  return resolveMessagingSelection({ env: inst.env(), sendblue: inst.sendblueEnv(), choice, manifestProvider });
}

/**
 * Persists a one-time Sendblue inference, or an explicit env selection, so a
 * later blank reading does not ask again and does not switch to another provider.
 */
export function ensureMessagingSelection(inst: Installation): MessagingSelection {
  const selection = selectionFromInstallation(inst);
  if (selection.invalid || !selection.provider) return selection;
  const state = inst.files.state();
  let manifestProvider: InstallationManifest["messagingProvider"] | undefined;
  try {
    manifestProvider = inst.files.manifest()?.messagingProvider;
  } catch {
    manifestProvider = undefined;
  }
  const wanted = manifestProviderName(selection.provider);
  if (state.messagingProviderChoice !== selection.provider) {
    inst.files.writeState({ ...inst.files.state(), messagingProviderChoice: selection.provider });
  }
  if (manifestProvider !== wanted) inst.files.update({ messagingProvider: wanted });
  return selectionFromInstallation(inst);
}

export function createMessagingProvider(id: MessagingProviderId, options: { env: () => NodeJS.ProcessEnv; ledger?: MessagingLedger; now?: () => Date; sendblue?: () => SendblueEnv }): MessagingProvider {
  if (id === "twilio") return new TwilioMessagingProvider({ env: () => readTwilioEnv(options.env()), ledger: options.ledger, now: options.now });
  if (id === "photon") return new PhotonMessagingProvider({ env: () => readPhotonEnv(options.env()), ledger: options.ledger, now: options.now });
  if (id === "local") return new LocalMessagingProvider({ env: () => readLocalEnv(options.env()), ledger: options.ledger, now: options.now });
  return new SendblueMessagingProvider({ env: options.sendblue ?? (() => sendblueRuntime.env()), ledger: options.ledger, now: options.now });
}

export function activeFromNumber(inst: Installation): string | undefined {
  const selection = selectionFromInstallation(inst);
  if (selection.provider === "twilio") return readTwilioEnv(inst.env()).fromNumber;
  if (selection.provider === "photon") return readPhotonEnv(inst.env()).fromNumber;
  if (selection.provider === "local") return readLocalEnv(inst.env()).fromNumber;
  if (selection.provider === "sendblue") return inst.sendblueEnv().fromNumber;
  return undefined;
}
