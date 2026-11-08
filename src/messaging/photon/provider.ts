import { z } from "zod";
import type { InboundMedia } from "../inbound";
import { MessagingError, toE164, type DeliveryReceipt, type OutgoingMessage } from "../Messenger";
import type { MessagingLedger } from "../ledger";
import { publicBase } from "../publicUrl";
import type { MessagingCapabilities, MessagingCheck, MessagingConfigField, MessagingLine, MessagingProvider, ProviderConnectContext, ProviderConnectResult, WebhookHttpRequest } from "../provider";
import { photonHttpClient, type PhotonClient, type PhotonLine } from "./client";
import { verifyPhotonWebhook } from "./signature";

export const PHOTON_WEBHOOK_PATH = "/webhooks/photon";

export interface PhotonEnv {
  projectId?: string;
  projectSecret?: string;
  fromNumber?: string;
  fromNumberRaw?: string;
  signingSecret?: string;
  standardSigningSecret?: string;
  publicBaseUrl?: string;
  publicBaseUrlRaw?: string;
}

function scrub(err: unknown, secrets: Array<string | undefined>, code: string, message: string): MessagingError {
  if (err instanceof MessagingError) {
    const leaked = secrets.some((secret) => secret && secret.length >= 6 && err.message.includes(secret));
    if (!leaked) return err;
  }
  return new MessagingError(code, message, err instanceof MessagingError ? { retryable: err.options.retryable, status: err.options.status } : {});
}

function photonInboundMedia(content: { type: string } & Record<string, unknown>): InboundMedia[] | undefined {
  if (content.type !== "attachment" && content.type !== "voice") return undefined;
  const mime = typeof content.mimeType === "string" ? content.mimeType.trim() : "";
  const url = typeof content.url === "string" ? content.url.trim() : "";
  return [{ ...(url ? { url } : {}), contentType: mime || (content.type === "voice" ? "audio/*" : "application/octet-stream") }];
}

const TextEvent = z.object({
  event: z.literal("messages"),
  space: z.object({ id: z.string().optional(), platform: z.string().optional(), type: z.string().optional(), phone: z.string().optional() }).passthrough(),
  message: z.object({
    id: z.string().min(1),
    timestamp: z.string().optional(),
    sender: z.object({ id: z.string() }).passthrough(),
    content: z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  }).passthrough(),
}).passthrough();

export function readPhotonEnv(env: NodeJS.ProcessEnv = process.env): PhotonEnv {
  const value = (k: string) => env[k]?.trim() || undefined;
  const fromRaw = value("TOURCORE_PHOTON_PHONE_NUMBER");
  const baseRaw = value("PUBLIC_BASE_URL");
  return {
    projectId: value("TOURCORE_PHOTON_PROJECT_ID"),
    projectSecret: value("TOURCORE_PHOTON_PROJECT_SECRET"),
    fromNumberRaw: fromRaw,
    fromNumber: fromRaw ? toE164(fromRaw) : undefined,
    signingSecret: value("TOURCORE_PHOTON_WEBHOOK_SECRET"),
    standardSigningSecret: value("TOURCORE_PHOTON_WEBHOOK_STANDARD_SECRET"),
    publicBaseUrlRaw: baseRaw,
    publicBaseUrl: publicBase(baseRaw),
  };
}

export const photonWebhookUrl = (env: PhotonEnv) => (env.publicBaseUrl ? `${env.publicBaseUrl}${PHOTON_WEBHOOK_PATH}` : undefined);

function baseCapabilities(lineModel?: "shared" | "dedicated"): MessagingCapabilities {
  return {
    inboundMessaging: true,
    outboundMessaging: true,
    inboundSms: false,
    outboundSms: false,
    arbitraryInboundSenders: true,
    requiresPreverifiedContacts: false,
    supportsMms: false,
    supportsImessage: true,
    supportsRcs: false,
    supportsDeliveryStatus: false,
    supportsReadStatus: false,
    smsFallback: false,
    ...(lineModel === "shared" ? { sharedLine: true, dedicatedLine: false } : {}),
    ...(lineModel === "dedicated" ? { sharedLine: false, dedicatedLine: true } : {}),
  };
}

/**
 * Photon / Spectrum cloud iMessage. Lines come only from the project's
 * provisioned lines. This adapter does not turn an arbitrary phone number
 * into an iMessage line.
 */
export class PhotonMessagingProvider implements MessagingProvider {
  readonly id = "photon" as const;
  readonly provider = "photon";
  readonly displayName = "Photon";
  readonly description = "Agent-focused messaging through Photon/Spectrum with iMessage support and provider-managed messaging lines. Available features depend on your Photon line and account.";
  readonly presentation = "MESSAGING" as const;
  private lineModel?: "shared" | "dedicated";

  constructor(
    private readonly options: {
      env?: () => PhotonEnv;
      client?: PhotonClient;
      ledger?: MessagingLedger;
      now?: () => Date;
    } = {},
  ) {}

  private env(): PhotonEnv {
    return this.options.env?.() ?? readPhotonEnv();
  }

  private client(): PhotonClient | undefined {
    if (this.options.client) return this.options.client;
    const env = this.env();
    if (!env.projectId || !env.projectSecret) return undefined;
    return photonHttpClient({ projectId: env.projectId, projectSecret: env.projectSecret });
  }

  capabilities(): MessagingCapabilities {
    return baseCapabilities(this.lineModel);
  }

  configFields(): MessagingConfigField[] {
    return [
      { name: "TOURCORE_PHOTON_PROJECT_ID", label: "Project ID", hint: "From the Photon project settings.", secret: true, required: true },
      { name: "TOURCORE_PHOTON_PROJECT_SECRET", label: "Project secret", hint: "From the Photon project settings. Tour Core can't show it again after you save it.", secret: true, required: true },
    ];
  }

  settingNames(): string[] {
    return ["TOURCORE_PHOTON_PROJECT_ID", "TOURCORE_PHOTON_PROJECT_SECRET", "TOURCORE_PHOTON_PHONE_NUMBER", "TOURCORE_PHOTON_WEBHOOK_SECRET", "TOURCORE_PHOTON_WEBHOOK_STANDARD_SECRET"];
  }

  credentialNames(): string[] {
    return ["TOURCORE_PHOTON_PROJECT_ID", "TOURCORE_PHOTON_PROJECT_SECRET", "TOURCORE_PHOTON_PHONE_NUMBER"];
  }

  webhookPath(): string {
    return PHOTON_WEBHOOK_PATH;
  }

  validateConfiguration(): { ok: boolean; problems: string[] } {
    const env = this.env();
    const problems: string[] = [];
    if (!env.projectId || !env.projectSecret) problems.push("The Photon project details aren't set up.");
    if (env.fromNumberRaw && !env.fromNumber) problems.push("That Photon line doesn't look like a full phone number.");
    return { ok: problems.length === 0, problems };
  }

  check(): Promise<MessagingCheck[]> {
    return this.inspect(false).then((r) => r.checks);
  }

  async connect(ctx: ProviderConnectContext): Promise<ProviderConnectResult> {
    const inspected = await this.inspect(true, ctx);
    return {
      ok: inspected.checks.every((c) => c.ok) && !inspected.needsLineChoice,
      checks: inspected.checks,
      webhook: inspected.webhook,
      removedPreviousWebhook: inspected.removedPrevious,
      ...(inspected.webhookUrl ? { webhookUrl: inspected.webhookUrl } : {}),
      ...(inspected.problem ? { problem: inspected.problem } : {}),
      ...(inspected.lines ? { lines: inspected.lines } : {}),
      ...(inspected.needsLineChoice ? { needsLineChoice: true } : {}),
    };
  }

  async disconnect(ownedWebhookUrls: string[]): Promise<void> {
    const client = this.client();
    if (!client || ownedWebhookUrls.length === 0) return;
    const hooks = await client.listWebhooks();
    for (const hook of hooks) {
      if (ownedWebhookUrls.includes(hook.webhookUrl)) await client.deleteWebhook(hook.id);
    }
  }

  verifyWebhook(request: WebhookHttpRequest) {
    const env = this.env();
    return verifyPhotonWebhook(request.rawBody, request.headers, { signingSecret: env.signingSecret, standardSigningSecret: env.standardSigningSecret });
  }

  parseInbound(rawBody: Buffer, now = new Date()) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ignored: "invalid json" };
    }
    const parsed = TextEvent.safeParse(payload);
    if (!parsed.success) return { ignored: "not a message event" };
    const event = parsed.data;
    if (event.space.type === "group") return { ignored: "group message" };
    const content = event.message.content;
    const media = photonInboundMedia(content);
    if (content.type !== "text" && !media) return { ignored: "unsupported message" };
    const from = toE164(event.message.sender.id);
    if (!from) return { ignored: "unreadable sender" };
    const to = event.space.phone ? toE164(event.space.phone) : undefined;
    const received = event.message.timestamp && !Number.isNaN(Date.parse(event.message.timestamp)) ? new Date(event.message.timestamp).toISOString() : now.toISOString();
    return {
      message: {
        provider: "photon",
        providerMessageId: event.message.id,
        from,
        ...(to ? { to } : {}),
        text: (content.text ?? "").trim(),
        ...(media ? { media } : {}),
        channel: "IMESSAGE" as const,
        receivedAt: received,
      },
    };
  }

  async send(message: OutgoingMessage): Promise<DeliveryReceipt> {
    const sentAt = (this.options.now?.() ?? new Date()).toISOString();
    if (message.audience === "OPERATOR") return { provider: this.provider, channel: "UNKNOWN", status: "SKIPPED", sentAt };
    const to = toE164(message.to);
    if (!to) throw new MessagingError("INVALID_NUMBER", "That phone number doesn't look right.");
    const client = this.client();
    if (!client) throw new MessagingError("PHOTON_NOT_CONFIGURED", "Visitor messaging isn't connected yet.");
    const from = this.env().fromNumber;
    const key = message.idempotencyKey ? `photon:out:${message.idempotencyKey}` : undefined;
    const earlier = key ? this.options.ledger?.get<DeliveryReceipt>(key) : undefined;
    if (earlier) return earlier;
    let response: { providerMessageId: string };
    try {
      response = await client.sendText({ to, text: message.body, ...(from ? { from } : {}) });
    } catch (err) {
      const env = this.env();
      throw scrub(err, [env.projectSecret, env.projectId, env.signingSecret, env.standardSigningSecret], "PHOTON_FAILED", "Sending through Photon failed.");
    }
    const receipt: DeliveryReceipt = { provider: this.provider, providerMessageId: response.providerMessageId, channel: "IMESSAGE", status: "SENT", sentAt };
    if (key) {
      this.options.ledger?.claim(key);
      this.options.ledger?.complete(key, receipt);
    }
    return receipt;
  }

  private async inspect(register: boolean, ctx?: ProviderConnectContext): Promise<{
    checks: MessagingCheck[];
    webhook: ProviderConnectResult["webhook"];
    webhookUrl?: string;
    problem?: string;
    lines?: MessagingLine[];
    needsLineChoice?: boolean;
    removedPrevious: boolean;
  }> {
    const env = this.env();
    const checks: MessagingCheck[] = [];
    let webhook: ProviderConnectResult["webhook"] = "not-attempted";
    let removedPrevious = false;
    let needsLineChoice = false;
    let lines: MessagingLine[] | undefined;
    if (!env.projectId || !env.projectSecret) {
      checks.push({ id: "account", label: "Photon project", ok: false, code: "PHOTON_KEYS_MISSING", message: "Visitor messaging isn't connected yet: the Photon project details aren't set up." });
    }
    const client = env.projectId && env.projectSecret ? this.client() : undefined;
    let accountOk = false;
    if (client) {
      try {
        await client.getProject();
        const info = await client.getImessageInfo();
        this.lineModel = info.type;
        accountOk = true;
        checks.push({
          id: "account",
          label: "Photon project",
          ok: true,
          message: info.type === "dedicated" ? "Photon project connected, with dedicated lines." : "Photon project connected, with a shared messaging line.",
        });
      } catch (err) {
        const code = err instanceof MessagingError ? err.code : "PHOTON_UNAVAILABLE";
        checks.push({
          id: "account",
          label: "Photon project",
          ok: false,
          code,
          message: code === "PHOTON_AUTH_FAILED" ? "Visitor messaging couldn't sign in to Photon. Check the project details." : "Couldn't reach Photon right now.",
        });
      }
    }

    if (client && accountOk) {
      try {
        const found = await client.listLines();
        lines = found.map((line) => ({ id: line.id, address: toE164(line.phoneNumber) ?? line.phoneNumber, status: line.status }));
        const chosen = this.chooseLine(env, found);
        if (chosen.needsChoice) {
          needsLineChoice = true;
          checks.push({ id: "line", label: "Messaging line", ok: false, code: "PHOTON_LINE_CHOICE", message: "This Photon project has more than one line. Choose one of the lines Photon reports as available." });
        } else if (chosen.problem) {
          checks.push({ id: "line", label: "Messaging line", ok: false, code: chosen.code, message: chosen.problem });
        } else {
          if (chosen.selected && chosen.selected !== env.fromNumber) ctx?.saveSecret({ TOURCORE_PHOTON_PHONE_NUMBER: chosen.selected });
          const label = chosen.selected ? `Messaging line connected (${chosen.selected})` : "Photon will use its shared messaging line.";
          checks.push({ id: "line", label: "Messaging line", ok: true, message: label });
        }
      } catch {
        checks.push({ id: "line", label: "Messaging line", ok: false, code: "PHOTON_LINES_UNCHECKED", message: "Couldn't check Photon's messaging lines right now." });
      }
    } else if (!checks.some((c) => c.id === "line")) {
      checks.push({ id: "line", label: "Messaging line", ok: false, code: "PHOTON_LINE_UNCHECKED", message: "The messaging line can be checked once the Photon project is connected." });
    }

    const url = photonWebhookUrl(env);
    if (!url) {
      checks.push({
        id: "incoming",
        label: "Incoming messages",
        ok: false,
        code: env.publicBaseUrlRaw ? "PUBLIC_BASE_URL_NOT_HTTPS" : "PUBLIC_BASE_URL_MISSING",
        message: "Replies from visitors can't reach this computer yet: no public https web address is set.",
      });
    } else if (client && accountOk && register && !needsLineChoice && checks.find((c) => c.id === "line")?.ok) {
      try {
        const hooks = await client.listWebhooks();
        const previous = ctx?.previousWebhookUrl;
        if (previous && previous !== url && previous.endsWith(PHOTON_WEBHOOK_PATH)) {
          const old = hooks.find((h) => h.webhookUrl === previous);
          if (old) {
            await client.deleteWebhook(old.id);
            removedPrevious = true;
          }
        }
        const mine = hooks.find((h) => h.webhookUrl === url);
        if (mine && (env.standardSigningSecret || env.signingSecret)) webhook = "already-registered";
        else if (mine) {
          const rotated = await client.rotateStandardSecret(mine.id);
          ctx?.saveSecret({ TOURCORE_PHOTON_WEBHOOK_STANDARD_SECRET: rotated.standardSigningSecret });
          webhook = "re-registered";
        } else {
          try {
            const created = await client.registerWebhook(url);
            ctx?.saveSecret({ TOURCORE_PHOTON_WEBHOOK_SECRET: created.signingSecret, TOURCORE_PHOTON_WEBHOOK_STANDARD_SECRET: created.standardSigningSecret });
            webhook = "registered";
          } catch (err) {
            if (err instanceof MessagingError && err.code === "PHOTON_WEBHOOK_EXISTS") webhook = "already-registered";
            else throw err;
          }
        }
        checks.push({ id: "incoming", label: "Incoming messages", ok: true, message: "Incoming messages connected" });
      } catch {
        checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "PHOTON_WEBHOOK_NOT_REGISTERED", message: "Photon didn't accept Tour Core's incoming-message address." });
      }
    } else if (client && accountOk && url) {
      try {
        const hooks = await client.listWebhooks();
        const mine = hooks.find((h) => h.webhookUrl === url);
        if (mine && (env.signingSecret || env.standardSigningSecret)) {
          webhook = "already-registered";
          checks.push({ id: "incoming", label: "Incoming messages", ok: true, message: "Incoming messages connected" });
        } else {
          checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "PHOTON_WEBHOOK_NOT_REGISTERED", message: "Photon isn't sending visitor replies to Tour Core yet. Run the messaging setup step." });
        }
      } catch {
        checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "PHOTON_WEBHOOK_UNCHECKED", message: "Couldn't check Photon's incoming-message address right now." });
      }
    } else {
      checks.push({ id: "incoming", label: "Incoming messages", ok: false, code: "PHOTON_WEBHOOK_UNCHECKED", message: "Incoming messages can be registered once the Photon project is connected." });
    }

    checks.push(
      env.publicBaseUrl
        ? { id: "verify-link", label: "Identity form link", ok: true, message: "Visitors can open the identity form from their phone" }
        : { id: "verify-link", label: "Identity form link", ok: false, code: "VERIFY_LINK_UNAVAILABLE", message: "Visitors can't open the identity form from their phone until a public https web address is set." },
    );
    return {
      checks,
      webhook,
      removedPrevious,
      ...(url ? { webhookUrl: url } : {}),
      ...(lines ? { lines } : {}),
      ...(needsLineChoice ? { needsLineChoice } : {}),
      ...(checks.some((c) => !c.ok) ? { problem: checks.find((c) => !c.ok)?.message } : {}),
    };
  }

  private chooseLine(env: PhotonEnv, lines: PhotonLine[]): { selected?: string; needsChoice?: boolean; problem?: string; code?: string } {
    const available = lines.filter((line) => line.status === "available").map((line) => ({ ...line, e164: toE164(line.phoneNumber) })).filter((line) => line.e164);
    if (this.lineModel === "shared" && available.length === 0) return {};
    if (this.lineModel === "dedicated" && available.length === 0) {
      return { problem: "This Photon project has no available provisioned line.", code: "PHOTON_LINE_MISSING" };
    }
    if (env.fromNumber) {
      const match = available.find((line) => line.e164 === env.fromNumber) ?? lines.find((line) => toE164(line.phoneNumber) === env.fromNumber);
      if (!match) return { problem: `${env.fromNumber} isn't a line on this Photon project.`, code: "PHOTON_LINE_NOT_FOUND" };
      if (match.status === "unavailable") return { problem: `${env.fromNumber} is not available on this Photon project.`, code: "PHOTON_LINE_UNAVAILABLE" };
      return { selected: env.fromNumber };
    }
    if (available.length === 1) return { selected: available[0]!.e164 };
    if (available.length > 1) return { needsChoice: true };
    if (this.lineModel === "shared") return {};
    return { problem: "This Photon project has no available provisioned line.", code: "PHOTON_LINE_MISSING" };
  }
}
