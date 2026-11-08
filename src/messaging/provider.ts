import type { InboundMessage } from "./inbound";
import type { DeliveryReceipt, MessageChannel, MessagingAdapter, OutgoingMessage } from "./Messenger";

/**
 * What Tour Core needs to know about a messaging transport. Adapters own
 * delivery. Booking, consent, schedules and access stay in Tour Core.
 * Optional methods are omitted when the provider does not support them.
 */

export const MESSAGING_PROVIDER_IDS = ["sendblue", "twilio", "photon", "local"] as const;
export type MessagingProviderId = (typeof MESSAGING_PROVIDER_IDS)[number];

export type MessagingReadiness = "NOT_CONFIGURED" | "CONNECTED" | "NEEDS_ACTION";

/** Only differences that change setup or what Tour Core can send or receive. */
export interface MessagingCapabilities {
  inboundMessaging: boolean;
  outboundMessaging: boolean;
  inboundSms: boolean;
  outboundSms: boolean;
  arbitraryInboundSenders: boolean;
  requiresPreverifiedContacts: boolean;
  supportsMms: boolean;
  supportsImessage: boolean;
  supportsRcs: boolean;
  supportsDeliveryStatus: boolean;
  supportsReadStatus: boolean;
  /** Set only after the provider account says which line model it has. */
  sharedLine?: boolean;
  dedicatedLine?: boolean;
  smsFallback?: boolean;
}

export interface MessagingConfigField {
  /** Secret-store name, also the environment variable. */
  name: string;
  label: string;
  hint: string;
  secret: boolean;
  required: boolean;
}

export interface MessagingLine {
  id: string;
  /** E.164 when the provider reports a phone number. */
  address: string;
  status?: string;
}

export interface MessagingCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Plain language; never contains secrets. */
  message: string;
  code?: string;
}

export interface WebhookHttpRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Exact public URL the provider signed, when Tour Core can reconstruct it. */
  url?: string;
}

export type WebhookVerification =
  | { ok: true; signed: boolean }
  | { ok: false; code: "WEBHOOK_UNSIGNED" | "WEBHOOK_SIGNATURE_INVALID" | "WEBHOOK_SIGNATURE_EXPIRED" };

export type InboundParse = { message: InboundMessage } | { ignored: string };

export interface ProviderConnectResult {
  ok: boolean;
  checks: MessagingCheck[];
  webhook: "already-registered" | "registered" | "re-registered" | "not-attempted" | "not-supported";
  removedPreviousWebhook: boolean;
  webhookUrl?: string;
  problem?: string;
  lines?: MessagingLine[];
  needsLineChoice?: boolean;
}

export interface ProviderConnectContext {
  saveSecret: (values: Record<string, string>) => void;
  previousWebhookUrl?: string;
}

export interface MessagingProvider extends MessagingAdapter {
  readonly id: MessagingProviderId;
  readonly displayName: string;
  readonly description: string;
  readonly presentation: MessageChannel;
  capabilities(): MessagingCapabilities;
  configFields(): MessagingConfigField[];
  /** Secret-store names that belong to this provider. Secure setup writes these; they stay saved when the operator switches away. */
  settingNames(): string[];
  /** Names whose change means the last connection test no longer applies. */
  credentialNames(): string[];
  validateConfiguration(): { ok: boolean; problems: string[] };
  /** Read-only health. Does not send a message and does not register a webhook. */
  check(): Promise<MessagingCheck[]>;
  /** Connection test: repairs Tour Core's own webhook when the provider supports that. */
  connect(ctx: ProviderConnectContext): Promise<ProviderConnectResult>;
  verifyWebhook(request: WebhookHttpRequest): WebhookVerification;
  parseInbound(rawBody: Buffer, now?: Date): InboundParse;
  webhookPath(): string;
  /** Drops Tour Core's webhook for this installation when the provider allows it. */
  disconnect?(ownedWebhookUrls: string[]): Promise<void>;
  send(message: OutgoingMessage): Promise<DeliveryReceipt>;
  /** Learns the channel a visitor just used, when the provider reports one. */
  noteChannel?(number: string, channel: InboundMessage["channel"]): void;
}

export interface MessagingProviderInfo {
  id: MessagingProviderId;
  displayName: string;
  description: string;
}
