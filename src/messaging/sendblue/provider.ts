import type { MessagingLedger } from "../ledger";
import type { DeliveryChannel, DeliveryReceipt, OutgoingMessage } from "../Messenger";
import type { MessagingCapabilities, MessagingCheck, MessagingConfigField, MessagingProvider, ProviderConnectContext, ProviderConnectResult, WebhookHttpRequest } from "../provider";
import { SendblueMessagingAdapter } from "./adapter";
import { connectSendblue } from "./connect";
import { checkSendblue } from "./readiness";
import { SENDBLUE_WEBHOOK_PATH, sendblueRuntime, webhookUrlFor, type SendblueClient, type SendblueEnv } from "./runtime";
import { parseSendblueInbound, verifySendblueWebhook } from "./webhook";

const CAPABILITIES: MessagingCapabilities = {
  inboundMessaging: true,
  outboundMessaging: true,
  inboundSms: true,
  outboundSms: true,
  arbitraryInboundSenders: true,
  requiresPreverifiedContacts: false,
  supportsMms: false,
  supportsImessage: true,
  supportsRcs: true,
  supportsDeliveryStatus: true,
  supportsReadStatus: false,
};

/**
 * Sendblue as one messaging provider. Sending, webhooks and the connection
 * test are the same functions Tour Core already used.
 */
export class SendblueMessagingProvider implements MessagingProvider {
  readonly id = "sendblue" as const;
  readonly provider = "sendblue";
  readonly displayName = "Sendblue";
  readonly description = "Managed iMessage/SMS messaging. Sandbox and dedicated-line behavior may differ.";
  readonly presentation = "MESSAGING" as const;
  private adapter?: SendblueMessagingAdapter;

  constructor(
    private readonly options: {
      env?: () => SendblueEnv;
      client?: SendblueClient;
      ledger?: MessagingLedger;
      now?: () => Date;
    } = {},
  ) {}

  private env(): SendblueEnv {
    return this.options.env?.() ?? sendblueRuntime.env();
  }

  private client(): SendblueClient {
    return this.options.client ?? sendblueRuntime.client(this.env());
  }

  capabilities(): MessagingCapabilities {
    return CAPABILITIES;
  }

  configFields(): MessagingConfigField[] {
    return [
      { name: "SENDBLUE_API_API_KEY", label: "API key", hint: "From the Sendblue dashboard, under API keys.", secret: true, required: true },
      { name: "SENDBLUE_API_API_SECRET", label: "API secret", hint: "Shown once when the key is created.", secret: true, required: true },
      { name: "SENDBLUE_FROM_NUMBER", label: "Texting number", hint: "The Sendblue number visitors will text, like +15551234567.", secret: false, required: true },
    ];
  }

  settingNames(): string[] {
    return ["SENDBLUE_API_API_KEY", "SENDBLUE_API_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"];
  }

  credentialNames(): string[] {
    return ["SENDBLUE_API_API_KEY", "SENDBLUE_API_API_SECRET", "SENDBLUE_FROM_NUMBER"];
  }

  webhookPath(): string {
    return SENDBLUE_WEBHOOK_PATH;
  }

  validateConfiguration(): { ok: boolean; problems: string[] } {
    const env = this.env();
    const problems: string[] = [];
    if (!env.apiKey || !env.apiSecret) problems.push("The Sendblue account details aren't set up.");
    if (!env.fromNumberRaw) problems.push("The Sendblue messaging number isn't set up yet.");
    else if (!env.fromNumber) problems.push("The Sendblue messaging number doesn't look like a full phone number (for example +15551234567).");
    return { ok: problems.length === 0, problems };
  }

  check(): Promise<MessagingCheck[]> {
    return checkSendblue(this.env());
  }

  async connect(ctx: ProviderConnectContext): Promise<ProviderConnectResult> {
    const result = await connectSendblue(this.env(), {
      saveWebhookSecret: (secret) => ctx.saveSecret({ SENDBLUE_WEBHOOK_SECRET: secret }),
      previousWebhookUrl: ctx.previousWebhookUrl,
    });
    return {
      ok: result.ok,
      checks: result.checks,
      webhook: result.webhook,
      removedPreviousWebhook: result.removedPreviousWebhook,
      ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
      ...(result.problem ? { problem: result.problem } : {}),
    };
  }

  async disconnect(ownedWebhookUrls: string[]): Promise<void> {
    const env = this.env();
    if (!env.apiKey || !env.apiSecret || ownedWebhookUrls.length === 0) return;
    const listed = (await this.client().webhooks.list()).webhooks?.receive ?? [];
    const mine = [...new Set(listed.map((h) => (typeof h === "string" ? h : h.url)).filter((url) => ownedWebhookUrls.includes(url)))];
    if (mine.length) await this.client().webhooks.delete({ webhooks: mine, type: "receive" });
  }

  verifyWebhook(request: WebhookHttpRequest) {
    return verifySendblueWebhook(request.rawBody, request.headers, this.env().webhookSecret);
  }

  parseInbound(rawBody: Buffer, now?: Date) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ignored: "invalid json" };
    }
    return parseSendblueInbound(payload, now);
  }

  noteChannel(number: string, channel: DeliveryChannel): void {
    this.sender().noteChannel(number, channel);
  }

  send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    return this.sender().send(message);
  }

  private sender(): SendblueMessagingAdapter {
    const env = this.env();
    if (!this.adapter) {
      this.adapter = new SendblueMessagingAdapter({
        client: this.client(),
        fromNumber: env.fromNumber ?? "",
        statusCallbackUrl: webhookUrlFor(env),
        ledger: this.options.ledger,
        now: this.options.now,
      });
    }
    return this.adapter;
  }
}

export function sendblueConfigured(env: SendblueEnv): boolean {
  return !!(env.apiKey && env.apiSecret && (env.fromNumber || env.fromNumberRaw));
}
