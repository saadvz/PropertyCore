import { randomUUID } from "node:crypto";
import type { MessagingLedger } from "../ledger";
import type { InboundMedia } from "../inbound";
import { MessagingError, toE164, type DeliveryReceipt, type OutgoingMessage } from "../Messenger";
import type { MessagingCapabilities, MessagingCheck, MessagingConfigField, MessagingProvider, ProviderConnectContext, ProviderConnectResult, WebhookHttpRequest } from "../provider";
import { localSmsOutbox, type LocalSmsOutbox } from "./outbox";

export const LOCAL_WEBHOOK_PATH = "/webhooks/local";
export const DEFAULT_LOCAL_FROM_NUMBER = "+15555550123";

/**
 * Operator-facing refusal when inject or local outbound is used on a property
 * that is not on the local loopback. Do not name other providers here.
 */
export const LOCAL_PROVIDER_REQUIRED = "This property isn't set up for local test texts. Switch it to local messaging first.";

function localInboundMedia(body: { media?: unknown; hasMedia?: unknown }): InboundMedia[] | undefined {
  if (Array.isArray(body.media)) {
    const media = body.media.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { url?: unknown; contentType?: unknown };
      const url = typeof row.url === "string" ? row.url.trim() : "";
      const contentType = typeof row.contentType === "string" ? row.contentType.trim() : "";
      if (!url && !contentType) return [];
      return [{ ...(url ? { url } : {}), ...(contentType ? { contentType } : {}) }];
    });
    if (media.length) return media;
  }
  if (body.hasMedia === true) return [{ contentType: "image/jpeg" }];
  return undefined;
}

const CAPABILITIES: MessagingCapabilities = {
  inboundMessaging: true,
  outboundMessaging: true,
  inboundSms: true,
  outboundSms: true,
  arbitraryInboundSenders: true,
  requiresPreverifiedContacts: false,
  supportsMms: false,
  supportsImessage: false,
  supportsRcs: false,
  supportsDeliveryStatus: false,
  supportsReadStatus: false,
  dedicatedLine: true,
};

export interface LocalEnv {
  fromNumber?: string;
  fromNumberRaw?: string;
  publicBaseUrl?: string;
}

export function readLocalEnv(env: NodeJS.ProcessEnv = process.env): LocalEnv {
  const raw = env.TOURCORE_LOCAL_FROM_NUMBER?.trim() || DEFAULT_LOCAL_FROM_NUMBER;
  return {
    fromNumberRaw: raw,
    fromNumber: toE164(raw),
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || undefined,
  };
}

/**
 * QA loopback. send() writes one outbox bubble and never opens a socket.
 * Inbound is POST /webhooks/local (or the inject_local_sms tool).
 */
export class LocalMessagingProvider implements MessagingProvider {
  readonly id = "local" as const;
  readonly provider = "local";
  readonly displayName = "Local loopback";
  readonly description = "QA loopback. No real texts are sent. Inbound is injected through Tour Core; replies go to an in-memory outbox.";
  readonly presentation = "MESSAGING" as const;

  constructor(
    private readonly options: {
      env?: () => LocalEnv;
      outbox?: LocalSmsOutbox;
      ledger?: MessagingLedger;
      now?: () => Date;
    } = {},
  ) {}

  private env(): LocalEnv {
    return this.options.env?.() ?? readLocalEnv();
  }

  private outbox(): LocalSmsOutbox {
    return this.options.outbox ?? localSmsOutbox();
  }

  capabilities(): MessagingCapabilities {
    return CAPABILITIES;
  }

  configFields(): MessagingConfigField[] {
    return [
      {
        name: "TOURCORE_LOCAL_FROM_NUMBER",
        label: "Loopback number",
        hint: "Reserved QA number visitors pretend to text, like +15555550123. Optional; Tour Core uses that reserved number when empty.",
        secret: false,
        required: false,
      },
    ];
  }

  settingNames(): string[] {
    return ["TOURCORE_LOCAL_FROM_NUMBER"];
  }

  credentialNames(): string[] {
    return ["TOURCORE_LOCAL_FROM_NUMBER"];
  }

  webhookPath(): string {
    return LOCAL_WEBHOOK_PATH;
  }

  validateConfiguration(): { ok: boolean; problems: string[] } {
    const env = this.env();
    if (env.fromNumberRaw && !env.fromNumber) {
      return { ok: false, problems: ["The local loopback number doesn't look like a full phone number (for example +15555550123)."] };
    }
    return { ok: true, problems: [] };
  }

  async check(): Promise<MessagingCheck[]> {
    const validation = this.validateConfiguration();
    if (!validation.ok) {
      return validation.problems.map((message, i) => ({ id: `config_${i}`, label: "Local loopback", ok: false, message }));
    }
    return [{ id: "loopback", label: "Local loopback", ok: true, message: "Local loopback is ready. No real texts are sent." }];
  }

  async connect(ctx: ProviderConnectContext): Promise<ProviderConnectResult> {
    void ctx;
    const checks = await this.check();
    const ok = checks.every((c) => c.ok);
    const base = this.env().publicBaseUrl?.replace(/\/$/, "");
    return {
      ok,
      checks,
      webhook: base ? "already-registered" : "not-supported",
      removedPreviousWebhook: false,
      ...(base ? { webhookUrl: `${base}${LOCAL_WEBHOOK_PATH}` } : {}),
    };
  }

  verifyWebhook(_request: WebhookHttpRequest) {
    return { ok: true as const, signed: false as const };
  }

  parseInbound(rawBody: Buffer, now = new Date()) {
    let body: { id?: unknown; from?: unknown; to?: unknown; text?: unknown; media?: unknown; hasMedia?: unknown; listingProperty?: unknown; property?: unknown };
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}") as typeof body;
    } catch {
      return { ignored: "invalid json" };
    }
    const from = typeof body.from === "string" ? toE164(body.from) : undefined;
    if (!from) return { ignored: "not a message event" };
    const text = typeof body.text === "string" ? body.text : "";
    const to = typeof body.to === "string" ? toE164(body.to) : undefined;
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : randomUUID();
    const media = localInboundMedia(body);
    const listingProperty = typeof body.listingProperty === "string" ? body.listingProperty.trim() : "";
    const pinnedProperty = typeof body.property === "string" ? body.property.trim() : "";
    return {
      message: {
        provider: "local",
        providerMessageId: id,
        from,
        ...(to ? { to } : {}),
        text,
        ...(media ? { media } : {}),
        channel: "SMS" as const,
        receivedAt: now.toISOString(),
        ...(listingProperty ? { listingProperty } : {}),
        ...(pinnedProperty ? { pinnedProperty } : {}),
      },
    };
  }

  async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    const sentAt = (this.options.now?.() ?? new Date()).toISOString();
    if (message.audience === "OPERATOR") {
      return { provider: this.provider, channel: "UNKNOWN", status: "SKIPPED", sentAt };
    }
    const to = toE164(message.to);
    if (!to) throw new MessagingError("INVALID_NUMBER", "That phone number doesn't look right.");
    const from = this.env().fromNumber ?? DEFAULT_LOCAL_FROM_NUMBER;
    const key = message.idempotencyKey ? `local:out:${message.idempotencyKey}` : undefined;
    const earlier = key ? this.options.ledger?.get<DeliveryReceipt>(key) : undefined;
    if (earlier) return earlier;

    const bubble = this.outbox().push({
      to,
      from,
      body: message.body,
      sentAt,
      audience: message.audience,
      ...(message.templateId ? { templateId: message.templateId } : {}),
    });
    const receipt: DeliveryReceipt = {
      provider: this.provider,
      providerMessageId: bubble.id,
      channel: "SMS",
      status: "SENT",
      sentAt,
    };
    if (key) this.options.ledger?.claim(key, this.options.now?.() ?? new Date(), { provider: this.provider, messageId: bubble.id });
    if (key) this.options.ledger?.complete(key, receipt);
    return receipt;
  }
}
