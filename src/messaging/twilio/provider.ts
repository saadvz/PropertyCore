import { MessagingError, toE164, type DeliveryReceipt, type DeliveryStatus, type OutgoingMessage } from "../Messenger";
import type { MessagingLedger } from "../ledger";
import { publicBase } from "../publicUrl";
import { providerConsentRecommendation } from "../consentPolicy";
import type { MessagingCapabilities, MessagingCheck, MessagingConfigField, MessagingProvider, ProviderConnectContext, ProviderConnectResult, WebhookHttpRequest } from "../provider";
import { twilioHttpClient, type TwilioClient } from "./client";
import { formParams, verifyTwilioSignature } from "./signature";
import { isAllowlisted, liveSmsOn } from "../../cleaner-core/liveSms";
import { isTenantWorker, parseDeploymentMode } from "../../install/deployment";

export const TWILIO_WEBHOOK_PATH = "/webhooks/twilio";

export interface TwilioEnv {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  fromNumberRaw?: string;
  publicBaseUrl?: string;
  publicBaseUrlRaw?: string;
  /** Set only in a touring process on the shared service: whether this number may be texted now. */
  mayText?: (to: string) => boolean;
  /** Set only in a touring process on the shared service: the shared address its number's texts go to. */
  incomingUrl?: string;
}

const CAPABILITIES: MessagingCapabilities = {
  inboundMessaging: true,
  outboundMessaging: true,
  inboundSms: true,
  outboundSms: true,
  arbitraryInboundSenders: true,
  requiresPreverifiedContacts: false,
  supportsMms: true,
  supportsImessage: false,
  supportsRcs: false,
  supportsDeliveryStatus: true,
  supportsReadStatus: false,
};

let clientOverride: ((env: TwilioEnv) => TwilioClient) | undefined;

/** Tests replace the Twilio REST client here. */
export function setTwilioClient(client: (env: TwilioEnv) => TwilioClient): () => void {
  const previous = clientOverride;
  clientOverride = client;
  return () => {
    clientOverride = previous;
  };
}

const STATUS: Record<string, DeliveryStatus> = {
  queued: "QUEUED",
  accepted: "QUEUED",
  sending: "QUEUED",
  sent: "SENT",
  delivered: "DELIVERED",
  undelivered: "FAILED",
  failed: "FAILED",
  canceled: "FAILED",
};

export function readTwilioEnv(env: NodeJS.ProcessEnv = process.env): TwilioEnv {
  const value = (k: string) => env[k]?.trim() || undefined;
  const fromRaw = value("TOURCORE_TWILIO_PHONE_NUMBER");
  const baseRaw = value("PUBLIC_BASE_URL");
  // A touring process on the shared service texts only under that service's live switch and allowlist.
  const worker = parseDeploymentMode(env.TOURCORE_DEPLOYMENT_MODE);
  const inWorker = !!worker && "mode" in worker && isTenantWorker(worker.mode);
  const incoming = inWorker ? publicBase(value("TOURCORE_TWILIO_INCOMING_URL")) : undefined;
  return {
    ...(inWorker ? { mayText: (to: string) => liveSmsOn(env) && isAllowlisted(env, to) } : {}),
    ...(incoming ? { incomingUrl: incoming } : {}),
    accountSid: value("TOURCORE_TWILIO_ACCOUNT_SID"),
    authToken: value("TOURCORE_TWILIO_AUTH_TOKEN"),
    fromNumberRaw: fromRaw,
    fromNumber: fromRaw ? toE164(fromRaw) : undefined,
    publicBaseUrlRaw: baseRaw,
    publicBaseUrl: publicBase(baseRaw),
  };
}

export const twilioWebhookUrl = (env: TwilioEnv) => (env.publicBaseUrl ? `${env.publicBaseUrl}${TWILIO_WEBHOOK_PATH}` : undefined);

/** Where the number's incoming texts should go: the shared service's address for a touring process, else this Tour Core's own. */
const twilioIncomingUrl = (env: TwilioEnv) => env.incomingUrl ?? twilioWebhookUrl(env);

function scrub(err: unknown, secrets: Array<string | undefined>, code: string, message: string): MessagingError {
  if (err instanceof MessagingError) {
    const leaked = secrets.some((secret) => secret && secret.length >= 6 && err.message.includes(secret));
    if (!leaked) return err;
  }
  return new MessagingError(code, message, err instanceof MessagingError ? { retryable: err.options.retryable, status: err.options.status } : {});
}

function header(headers: WebhookHttpRequest["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Twilio Programmable SMS. Connectivity is not carrier registration:
 * a working account can still be waiting on the deployer's own messaging approval.
 */
export class TwilioMessagingProvider implements MessagingProvider {
  readonly id = "twilio" as const;
  readonly provider = "twilio";
  readonly displayName = "Twilio";
  readonly description = "Dedicated SMS number with low usage cost. Carrier registration may be required depending on your country and use case.";
  readonly presentation = "MESSAGING" as const;

  constructor(
    private readonly options: {
      env?: () => TwilioEnv;
      client?: TwilioClient;
      ledger?: MessagingLedger;
      now?: () => Date;
    } = {},
  ) {}

  private env(): TwilioEnv {
    return this.options.env?.() ?? readTwilioEnv();
  }

  private client(): TwilioClient | undefined {
    if (this.options.client) return this.options.client;
    const env = this.env();
    if (clientOverride) return clientOverride(env);
    if (!env.accountSid || !env.authToken) return undefined;
    return twilioHttpClient({ accountSid: env.accountSid, authToken: env.authToken });
  }

  capabilities(): MessagingCapabilities {
    return CAPABILITIES;
  }

  configFields(): MessagingConfigField[] {
    return [
      { name: "TOURCORE_TWILIO_ACCOUNT_SID", label: "Account SID", hint: "From the Twilio console. Starts with AC.", secret: true, required: true },
      { name: "TOURCORE_TWILIO_AUTH_TOKEN", label: "Auth token", hint: "From the Twilio console. Tour Core can't show it again after you save it.", secret: true, required: true },
      { name: "TOURCORE_TWILIO_PHONE_NUMBER", label: "Texting number", hint: "The Twilio number visitors will text, like +15555550123.", secret: false, required: true },
    ];
  }

  settingNames(): string[] {
    return ["TOURCORE_TWILIO_ACCOUNT_SID", "TOURCORE_TWILIO_AUTH_TOKEN", "TOURCORE_TWILIO_PHONE_NUMBER"];
  }

  credentialNames(): string[] {
    return this.settingNames();
  }

  defaultConsentMode(): "keyword_confirm" | "disabled" {
    return providerConsentRecommendation("twilio").mode;
  }

  webhookPath(): string {
    return TWILIO_WEBHOOK_PATH;
  }

  validateConfiguration(): { ok: boolean; problems: string[] } {
    const env = this.env();
    const problems: string[] = [];
    if (!env.accountSid || !env.authToken) problems.push("The Twilio account details aren't set up.");
    else if (!env.accountSid.startsWith("AC")) problems.push("That Twilio Account SID doesn't look right.");
    if (!env.fromNumberRaw) problems.push("The Twilio phone number isn't set up yet.");
    else if (!env.fromNumber) problems.push("The Twilio phone number doesn't look like a full phone number (for example +15555550123).");
    return { ok: problems.length === 0, problems };
  }

  async check(): Promise<MessagingCheck[]> {
    return (await this.inspect(false)).checks;
  }

  async connect(ctx: ProviderConnectContext): Promise<ProviderConnectResult> {
    const inspected = await this.inspect(true);
    void ctx;
    return {
      ok: inspected.checks.every((c) => c.ok),
      checks: inspected.checks,
      webhook: inspected.webhook,
      removedPreviousWebhook: false,
      ...(inspected.webhookUrl ? { webhookUrl: inspected.webhookUrl } : {}),
      ...(inspected.problem ? { problem: inspected.problem } : {}),
    };
  }

  verifyWebhook(request: WebhookHttpRequest) {
    const params = formParams(request.rawBody);
    return verifyTwilioSignature(this.env().authToken, request.url, params, header(request.headers, "x-twilio-signature"));
  }

  parseInbound(rawBody: Buffer, now = new Date()) {
    const params = formParams(rawBody);
    const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
    if (status && status !== "received" && !params.Body) return { ignored: "delivery status" };
    if (status && status !== "received" && params.MessageStatus) return { ignored: "delivery status" };
    const id = params.MessageSid || params.SmsMessageSid;
    if (!id) return { ignored: "not a message event" };
    const from = toE164(params.From ?? "");
    if (!from) return { ignored: "unreadable sender" };
    const to = toE164(params.To ?? "");
    const mediaCount = Number(params.NumMedia ?? "0");
    const media = Number.isFinite(mediaCount)
      ? Array.from({ length: mediaCount }, (_, i) => ({ url: params[`MediaUrl${i}`], contentType: params[`MediaContentType${i}`] })).filter((m) => m.url)
      : [];
    return {
      message: {
        provider: "twilio",
        providerMessageId: id,
        from,
        ...(to ? { to } : {}),
        text: (params.Body ?? "").trim(),
        ...(media.length ? { media } : {}),
        channel: "SMS" as const,
        receivedAt: now.toISOString(),
        ...(status ? { metadata: { status } } : {}),
      },
    };
  }

  async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    return this.deliver(message);
  }

  async sendMedia(message: OutgoingMessage & { mediaUrls: string[] }): Promise<DeliveryReceipt> {
    return this.deliver(message, message.mediaUrls);
  }

  private async deliver(message: OutgoingMessage, mediaUrls?: string[]): Promise<DeliveryReceipt> {
    const sentAt = (this.options.now?.() ?? new Date()).toISOString();
    if (message.audience === "OPERATOR") return { provider: this.provider, channel: "UNKNOWN", status: "SKIPPED", sentAt };
    const to = toE164(message.to);
    if (!to) throw new MessagingError("INVALID_NUMBER", "That phone number doesn't look right.");
    const env = this.env();
    if (env.mayText && !env.mayText(to)) {
      return { provider: this.provider, channel: "SMS", status: "SUPPRESSED", sentAt, error: { code: "LIVE_TEXTS_OFF", message: "Live texts are off on this service, or this number isn't on its allowlist." } };
    }
    const from = env.fromNumber;
    if (!from) throw new MessagingError("TWILIO_FROM_NUMBER_INVALID", "The messaging number isn't set up correctly.");
    const client = this.client();
    if (!client) throw new MessagingError("TWILIO_NOT_CONFIGURED", "Visitor messaging isn't connected yet.");

    const key = message.idempotencyKey ? `twilio:out:${message.idempotencyKey}` : undefined;
    const earlier = key ? this.options.ledger?.get<DeliveryReceipt>(key) : undefined;
    if (earlier) return earlier;

    const url = twilioWebhookUrl(env);
    let response: Awaited<ReturnType<TwilioClient["sendSms"]>>;
    try {
      response = await client.sendSms({ to, from, body: message.body, ...(url ? { statusCallback: url } : {}), ...(mediaUrls?.length ? { mediaUrls } : {}) });
    } catch (err) {
      throw scrub(err, [env.authToken, env.accountSid], "TWILIO_FAILED", "Sending through Twilio failed.");
    }
    const status = STATUS[(response.status ?? "").toLowerCase()] ?? "QUEUED";
    const receipt: DeliveryReceipt = {
      provider: this.provider,
      providerMessageId: response.sid,
      channel: "SMS",
      status,
      sentAt,
      ...(status === "FAILED" ? { error: { code: "TWILIO_SEND_ERROR", message: "The message couldn't be delivered." } } : {}),
    };
    if (key) {
      this.options.ledger?.claim(key);
      this.options.ledger?.complete(key, receipt);
    }
    return receipt;
  }

  private async inspect(register: boolean): Promise<{ checks: MessagingCheck[]; webhook: ProviderConnectResult["webhook"]; webhookUrl?: string; problem?: string }> {
    const env = this.env();
    const checks: MessagingCheck[] = [];
    const validation = this.validateConfiguration();
    if (!env.accountSid || !env.authToken) {
      checks.push({ id: "account", label: "Twilio account", ok: false, code: "TWILIO_KEYS_MISSING", message: "Visitor messaging isn't connected yet: the Twilio account details aren't set up." });
    }
    const client = env.accountSid && env.authToken ? this.client() : undefined;
    let accountOk = false;
    if (client) {
      try {
        await client.getAccount();
        accountOk = true;
        checks.push({ id: "account", label: "Twilio account", ok: true, message: "Twilio account connected. Carrier registration, if your use case needs it, is still your responsibility." });
      } catch (err) {
        const code = err instanceof MessagingError ? err.code : "TWILIO_UNAVAILABLE";
        checks.push({
          id: "account",
          label: "Twilio account",
          ok: false,
          code,
          message: code === "TWILIO_AUTH_FAILED" ? "Visitor messaging couldn't sign in to Twilio. Check the Twilio account details." : "Couldn't reach Twilio right now.",
        });
      }
    }

    let number: Awaited<ReturnType<TwilioClient["findNumber"]>>;
    if (!env.fromNumberRaw) checks.push({ id: "line", label: "Messaging number", ok: false, code: "TWILIO_FROM_NUMBER_MISSING", message: "The Twilio phone number isn't set up yet." });
    else if (!env.fromNumber) checks.push({ id: "line", label: "Messaging number", ok: false, code: "TWILIO_FROM_NUMBER_INVALID", message: "The Twilio phone number doesn't look like a full phone number (for example +15555550123)." });
    else if (client && accountOk) {
      try {
        number = await client.findNumber(env.fromNumber);
        if (!number) checks.push({ id: "line", label: "Messaging number", ok: false, code: "TWILIO_NUMBER_NOT_FOUND", message: `${env.fromNumber} isn't a phone number on this Twilio account.` });
        else checks.push({ id: "line", label: "Messaging number", ok: true, message: `Messaging number connected (${env.fromNumber})` });
      } catch {
        checks.push({ id: "line", label: "Messaging number", ok: false, code: "TWILIO_NUMBER_UNCHECKED", message: "Couldn't check the messaging number with Twilio right now." });
      }
    } else if (env.fromNumber) {
      checks.push({ id: "line", label: "Messaging number", ok: false, code: "TWILIO_LINE_UNCHECKED", message: `The messaging number (${env.fromNumber}) can be checked once the Twilio account is connected.` });
    }

    const url = twilioIncomingUrl(env);
    let webhook: ProviderConnectResult["webhook"] = "not-attempted";
    if (!url) {
      checks.push({
        id: "incoming",
        label: "Incoming messages",
        ok: false,
        code: env.publicBaseUrlRaw ? "PUBLIC_BASE_URL_NOT_HTTPS" : "PUBLIC_BASE_URL_MISSING",
        message: "Replies from visitors can't reach this computer yet: no public https web address is set.",
      });
    } else if (number && client && register) {
      try {
        if (number.smsUrl === url) webhook = "already-registered";
        else {
          await client.setSmsUrl(number.sid, url);
          webhook = "registered";
        }
        checks.push({ id: "incoming", label: "Incoming messages", ok: true, message: "Incoming messages connected" });
      } catch {
        checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "TWILIO_WEBHOOK_NOT_REGISTERED", message: "Twilio didn't accept Tour Core's incoming-message address." });
      }
    } else if (number && number.smsUrl === url) {
      webhook = "already-registered";
      checks.push({ id: "incoming", label: "Incoming messages", ok: true, message: "Incoming messages connected" });
    } else if (number) {
      checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "TWILIO_WEBHOOK_NOT_REGISTERED", message: "Twilio isn't sending visitor replies to Tour Core yet. Run the messaging setup step." });
    } else {
      checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "TWILIO_WEBHOOK_UNCHECKED", message: "Incoming messages can be checked once the Twilio number is connected." });
    }

    checks.push(
      env.publicBaseUrl
        ? { id: "verify-link", label: "Identity form link", ok: true, message: "Visitors can open the identity form from their phone" }
        : { id: "verify-link", label: "Identity form link", ok: false, code: "VERIFY_LINK_UNAVAILABLE", message: "Visitors can't open the identity form from their phone until a public https web address is set." },
    );
    if (!validation.ok && checks.length === 0) checks.push({ id: "account", label: "Twilio account", ok: false, message: validation.problems[0] ?? "Twilio isn't set up." });
    return { checks, webhook, ...(url ? { webhookUrl: url } : {}), ...(checks.some((c) => !c.ok) ? { problem: checks.find((c) => !c.ok)?.message } : {}) };
  }
}
