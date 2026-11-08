import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { parsePhone } from "../core/phone";
import { cleanerCoreEnabled } from "./flag";
import { liveDeskFor } from "./liveDesk";
import { CLEANER_GROUP_HOOK_PATH, CLEANER_GROUP_IDENTITY, CLEANER_PIN_STATUS_PATH } from "./liveSms";
import { conversationMediaUrl, type InboundMedia } from "./photos";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";

export const CLEANER_TWILIO_PATH = "/webhooks/twilio/cleaner-core";
export const CLEANER_TWILIO_STATUS_PATH = CLEANER_PIN_STATUS_PATH;
export const CLEANER_TWILIO_GROUP_PATH = CLEANER_GROUP_HOOK_PATH;
/** An empty TwiML reply. Twilio expects XML from a messaging webhook and logs error 12300 for JSON. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
export const TWIML_CONTENT_TYPE = "text/xml; charset=utf-8";
/** Twilio sends at most 10 attachments with one MMS. */
const MAX_MEDIA = 10;

/** An MMS's attachments: NumMedia (0 to 10), then MediaUrl{i} and MediaContentType{i}. Never logged. */
export function mediaOf(params: Record<string, string>): InboundMedia[] {
  const count = Math.min(MAX_MEDIA, Math.max(0, Number.parseInt(params.NumMedia ?? "0", 10) || 0));
  return Array.from({ length: count }, (_, index) => ({ url: params[`MediaUrl${index}`]?.trim() ?? "", contentType: params[`MediaContentType${index}`]?.trim() ?? "" })).filter(
    (item) => item.url.length > 0,
  );
}

export function textAddressedTo(raw: Buffer, number: string | undefined): boolean {
  if (!number) return false;
  const to = formParams(raw).To;
  if (!to) return false;
  const left = parsePhone(to);
  const right = parsePhone(number);
  return Boolean(left && right && left === right);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Each webhook's first steps: cleaning texts on (else 404), then a valid Twilio signature (else 403). */
function signedForm(input: { rawBody: Buffer; headers: IncomingHttpHeaders; url: string | undefined; env: () => NodeJS.ProcessEnv }): { params: Record<string, string> } | { status: number; body: string } {
  const env = input.env();
  if (!cleanerCoreEnabled(env)) return { status: 404, body: "" };
  const params = formParams(input.rawBody);
  const signature = header(input.headers, "x-twilio-signature");
  const verified = verifyTwilioSignature(env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim(), input.url, params, signature);
  if (!verified.ok) return { status: 403, body: JSON.stringify({ error: "unauthorized" }) };
  return { params };
}

/**
 * Inbound texts for the cleaning number. STOP and START are applied
 * before any job step. The HTTP body never includes a door code or a reply.
 */
export async function handleCleanerTwilioWebhook(input: {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  url: string | undefined;
  /** Live: the desk keeps this getter. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string; contentType?: string }> {
  const form = signedForm(input);
  if (!("params" in form)) return form;
  const params = form.params;
  const from = params.From ?? "";
  const text = params.Body ?? "";
  const id = params.MessageSid?.trim() || createHash("sha256").update(`${from}\n${text}`).digest("hex");
  const media = mediaOf(params);
  const desk = liveDeskFor(input.root, input.env, input.now);
  await desk.inbound({ id, from, text, ...(media.length > 0 ? { media } : {}) });
  return { status: 200, body: EMPTY_TWIML, contentType: TWIML_CONTENT_TYPE };
}

/** Delivery status for a door-code text. Signature required. Never unseals or resends the code. */
export async function handleCleanerTwilioStatus(input: {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  url: string | undefined;
  /** Live: the desk keeps this getter. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const form = signedForm(input);
  if (!("params" in form)) return form;
  const params = form.params;
  const sid = params.MessageSid?.trim() || params.SmsSid?.trim() || "";
  const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (sid && status) {
    const desk = liveDeskFor(input.root, input.env, input.now);
    await desk.notePinDelivery({ sid, status });
  }
  return { status: 200, body: "{}" };
}

/** A group message's attachments, from the Media JSON of onMessageAdded. Each is read through the Conversations media service. */
function groupMediaOf(params: Record<string, string>): InboundMedia[] {
  const service = params.ChatServiceSid?.trim() ?? "";
  let items: unknown;
  try {
    items = JSON.parse(params.Media ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_MEDIA).flatMap((item: { Sid?: unknown; ContentType?: unknown }) => {
    const url = typeof item?.Sid === "string" ? conversationMediaUrl(service, item.Sid) : undefined;
    return url ? [{ url, contentType: typeof item.ContentType === "string" ? item.ContentType.trim() : "" }] : [];
  });
}

/**
 * Replies in the group, from the webhook Cleaner Core adds to each group conversation. Signature
 * required. Only onMessageAdded is read. Cleaner Core's own posts are skipped, and the desk takes a
 * message only from the saved group and a saved person in it. The HTTP body never includes a reply.
 */
export async function handleCleanerGroupWebhook(input: {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  url: string | undefined;
  /** Live: the desk keeps this getter. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const form = signedForm(input);
  if (!("params" in form)) return form;
  const params = form.params;
  const author = params.Author?.trim() ?? "";
  const conversationSid = params.ConversationSid?.trim() ?? "";
  const id = params.MessageSid?.trim() ?? "";
  if (params.EventType !== "onMessageAdded" || !author || author === CLEANER_GROUP_IDENTITY || !conversationSid || !id) return { status: 200, body: "{}" };
  const media = groupMediaOf(params);
  const desk = liveDeskFor(input.root, input.env, input.now);
  await desk.inboundGroup({ conversationSid, id, from: author, text: params.Body ?? "", ...(media.length > 0 ? { media } : {}) });
  return { status: 200, body: "{}" };
}
