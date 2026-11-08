import { DEMO_VERIFICATION_FORM_URL, type TourCoreConfig } from "./config/tourCoreConfig";
import { systemClock, type Clock } from "./core/clock";
import { TourCore, type TourCoreDeps } from "./core/TourCore";
import type { DurinAccessAdapter } from "./durin/DurinAccessAdapter";
import { MockDurinAccessAdapter } from "./durin/MockDurinAccessAdapter";
import type { Installation } from "./install/installation";
import { DemoMessagingAdapter, type Messenger } from "./messaging/Messenger";
import type { MessagingLedger } from "./messaging/ledger";
import type { MessagingCheck } from "./messaging/provider";
import { usesLocalMessaging } from "./messaging/propertyScope";
import { createMessagingProvider, currentMessagingInput, resolveMessagingSelection, selectionFromInstallation } from "./messaging/registry";
import { sendblueConfigured } from "./messaging/sendblue/provider";
import { InMemoryStore, type TourCoreStore } from "./storage/Store";
import { presentVerification } from "./setup/verification";
import { BasicFormVerification, NoFormVerification, type VerificationProvider } from "./verification/basicForm";

/** A configured choice this build can't run yet. Message is operator-facing. */
export class UnavailableModeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Log = (line: string) => void;

// Each config mode maps to an adapter here and nowhere else.

export function createStore(config: TourCoreConfig): TourCoreStore {
  if (config.storageMode === "memory") return new InMemoryStore();
  throw new UnavailableModeError("STORAGE_UNAVAILABLE", "Google Drive is connected for the whole installation, not as a per-property mode. Tour records follow the installation storage setting.");
}

export function createMessenger(config: TourCoreConfig, log?: Log, options: { ledger?: MessagingLedger } = {}): Messenger {
  if (config.messagingMode === "demo") return new DemoMessagingAdapter(log);
  const input = currentMessagingInput();
  if (usesLocalMessaging(config, resolveMessagingSelection(input))) {
    return createMessagingProvider("local", { env: () => input.env, sendblue: () => input.sendblue, ledger: options.ledger });
  }
  return createLiveMessagingTransport(options.ledger);
}

/** The real-phone transport for the selected messaging provider. */
export function createLiveMessagingTransport(ledger?: MessagingLedger): Messenger {
  const input = currentMessagingInput();
  const selection = resolveMessagingSelection(input);
  if (!selection.provider) {
    throw new UnavailableModeError("MESSAGING_NOT_CONFIGURED", "Visitor messaging isn't connected yet.");
  }
  if (selection.provider === "sendblue" && !sendblueConfigured(input.sendblue)) {
    throw new UnavailableModeError("SENDBLUE_NOT_CONFIGURED", "Visitor messaging isn't connected yet: Sendblue isn't set up on this computer.");
  }
  return createMessagingProvider(selection.provider, { env: () => input.env, sendblue: () => input.sendblue, ledger });
}

/** The running installation's transport. Uses the saved provider, not a hardcoded one. */
export function liveTransportFor(inst: Installation, ledger?: MessagingLedger): Messenger {
  const selection = selectionFromInstallation(inst);
  if (!selection.provider) throw new UnavailableModeError("MESSAGING_NOT_CONFIGURED", "Visitor messaging isn't connected yet.");
  return createMessagingProvider(selection.provider, { env: () => inst.env(), sendblue: () => inst.sendblueEnv(), ledger, now: () => new Date(inst.now()) });
}

/** Whether the chosen messaging can reach visitors, as plain-language checks. Demo messaging always can. */
export async function checkMessaging(config: TourCoreConfig): Promise<MessagingCheck[]> {
  if (config.messagingMode === "demo") return [];
  const input = currentMessagingInput();
  const selection = resolveMessagingSelection(input);
  const id = usesLocalMessaging(config, selection) ? "local" : (selection.provider ?? "sendblue");
  return createMessagingProvider(id, { env: () => input.env, sendblue: () => input.sendblue }).check();
}

export function createVerificationProvider(config: TourCoreConfig): VerificationProvider {
  const mode = presentVerification(config).verificationMode;
  if (mode === "none") return new NoFormVerification();
  return new BasicFormVerification(config.verificationFormUrl ?? DEMO_VERIFICATION_FORM_URL);
}

export function createDurin(config: TourCoreConfig, clock: Clock, log?: Log): DurinAccessAdapter {
  if (config.accessMode === "door-demo") {
    return new MockDurinAccessAdapter({
      doorNames: Object.fromEntries(config.doors.map((d) => [d.id, d.name])),
      timeZone: config.property.timezone,
      now: () => clock.now(),
      log,
    });
  }
  throw new UnavailableModeError("ACCESS_UNAVAILABLE", "Live door access isn't set up here. Switch to demo door access — no real doors open.");
}

export function createTourCore(config: TourCoreConfig, overrides: Partial<TourCoreDeps> = {}): TourCore {
  const clock = overrides.clock ?? systemClock;
  return new TourCore({
    config,
    clock,
    store: overrides.store ?? createStore(config),
    messenger: overrides.messenger ?? createMessenger(config),
    verification: overrides.verification ?? createVerificationProvider(config),
    durin: overrides.durin ?? createDurin(config, clock),
    ...(overrides.availability ? { availability: overrides.availability } : {}),
    ...(overrides.approvedContent ? { approvedContent: overrides.approvedContent } : {}),
    ...(overrides.storageRead ? { storageRead: overrides.storageRead } : {}),
    ...(overrides.beforeAccess ? { beforeAccess: overrides.beforeAccess } : {}),
    ...(overrides.verificationLink ? { verificationLink: overrides.verificationLink } : {}),
    ...(overrides.correlationId ? { correlationId: overrides.correlationId } : {}),
    ...(overrides.otherBusyStarts ? { otherBusyStarts: overrides.otherBusyStarts } : {}),
    ...(overrides.otherBusyWindows ? { otherBusyWindows: overrides.otherBusyWindows } : {}),
    ...(overrides.slotLockBarrier ? { slotLockBarrier: overrides.slotLockBarrier } : {}),
  });
}
