import { parsePhone } from "../core/phone";
import { publicBaseUrl } from "../messaging/publicUrl";
import { twilioHttpClient, type TwilioClient } from "../messaging/twilio/client";
import { GroupNotConfirmed, type RefusedPhone } from "./groupThread";
import { isOn } from "./flag";

/** Off unless CLEANER_CORE_LIVE_SMS is exactly "1" or "true". */
export function liveSmsOn(env: NodeJS.ProcessEnv): boolean {
  return isOn(env.CLEANER_CORE_LIVE_SMS);
}

/**
 * The old operator allowlist. Cleaner Core reads it only to vouch for a landlord's phone that wasn't
 * confirmed at sign-up (an account made in /admin). Tour Core's touring texts still go by it.
 */
export function smsAllowlist(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CLEANER_CORE_SMS_ALLOWLIST ?? "";
  const phones: string[] = [];
  for (const part of raw.split(",")) {
    const phone = parsePhone(part.trim());
    if (phone) phones.push(phone);
  }
  return phones;
}

/** True when CLEANER_CORE_SMS_ALLOWLIST holds "*": any number may be texted, except this service's own lines (every tenant's, on the multi-tenant service). */
export function smsAllowsAny(env: NodeJS.ProcessEnv): boolean {
  return (env.CLEANER_CORE_SMS_ALLOWLIST ?? "").split(",").some((part) => part.trim() === "*");
}

/** This service's own numbers. They are never texted. */
const OWN_LINES = ["CLEANER_CORE_TWILIO_PHONE_NUMBER", "TOURCORE_TWILIO_PHONE_NUMBER", "TOURCORE_PHOTON_PHONE_NUMBER"] as const;

function ownLine(env: NodeJS.ProcessEnv, phone: string): boolean {
  if (OWN_LINES.some((key) => parsePhone(env[key] ?? "") === phone)) return true;
  // On the multi-tenant service, every tenant's number is one of this service's lines.
  return (env.CLEANER_CORE_SERVICE_LINES ?? "").split(",").some((line) => parsePhone(line.trim()) === phone);
}

/** True when the old operator allowlist holds this number. Tour Core's touring texts still go by it. */
export function isAllowlisted(env: NodeJS.ProcessEnv, phone: string): boolean {
  const parsed = parsePhone(phone);
  if (!parsed) return false;
  if (smsAllowsAny(env)) return !ownLine(env, parsed);
  return smsAllowlist(env).includes(parsed);
}

/**
 * The deny list: any real phone number except this service's own lines. Who of those may be texted
 * is consent, held per account: the landlord's phone confirmed at sign-up, and each person's YES
 * and STOP (saadvz/PropertyCore#164). The desk and the engine check that before a text reaches here.
 */
export function mayText(env: NodeJS.ProcessEnv, phone: string): boolean {
  const parsed = parsePhone(phone);
  return Boolean(parsed) && !ownLine(env, parsed!);
}

/** The landlord's phone, confirmed with a code when they signed up (saadvz/PropertyCore#162). Each tenant's desk gets its own. */
export function verifiedLandlordPhone(env: NodeJS.ProcessEnv): string | undefined {
  return parsePhone(env.CLEANER_CORE_LANDLORD_PHONE?.trim() ?? "");
}

/**
 * True when `host` is the account's landlord: the phone confirmed at sign-up, or, for an account
 * with no landlord record at all (made in /admin), a phone the old operator allowlist approves.
 * Nobody on the account is texted until this holds. A landlord record that isn't a confirmed phone
 * (an owner whose code hasn't checked out, or a value that isn't a phone) fails closed.
 */
export function landlordConfirmed(env: NodeJS.ProcessEnv, host: string | undefined): boolean {
  const phone = parsePhone(host ?? "");
  if (!phone || ownLine(env, phone)) return false;
  if (env.CLEANER_CORE_LANDLORD_PHONE?.trim()) return phone === verifiedLandlordPhone(env);
  return isAllowlisted(env, phone);
}

let clientOverride: TwilioClient | undefined;

/** Tests replace the Cleaner Core Twilio client. Unset uses the account in the environment. */
export function setCleanerTwilioClient(client: TwilioClient | undefined): void {
  clientOverride = client;
}

/** Cleaner Core's own Twilio login, trimmed. Undefined unless both parts are set. */
export function cleanerTwilioLogin(env: NodeJS.ProcessEnv): { accountSid: string; authToken: string } | undefined {
  const accountSid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return undefined;
  return { accountSid, authToken };
}

/** The Basic Authorization header for a Twilio login. */
export function basicAuth(login: { accountSid: string; authToken: string }): string {
  return `Basic ${Buffer.from(`${login.accountSid}:${login.authToken}`).toString("base64")}`;
}

export function cleanerTwilioClient(env: NodeJS.ProcessEnv): TwilioClient {
  if (clientOverride) return clientOverride;
  const login = cleanerTwilioLogin(env);
  if (!login) throw new Error("not sent");
  return twilioHttpClient(login);
}

export const CLEANER_PIN_STATUS_PATH = "/webhooks/twilio/cleaner-core/status";

export function cleanerPinStatusUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}${CLEANER_PIN_STATUS_PATH}`;
}

/**
 * Sends one text when live texts are on and the number isn't one of this service's own lines.
 * Consent is the caller's check. A failed Twilio status throws.
 */
export async function sendLiveSms(env: NodeJS.ProcessEnv, text: { to: string; body: string; statusCallback?: string }): Promise<string | undefined> {
  if (!liveSmsOn(env) || !mayText(env, text.to)) return undefined;
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!from) throw new Error("not sent");
  const result = await cleanerTwilioClient(env).sendSms({
    to: text.to,
    from,
    body: text.body,
    ...(text.statusCallback ? { statusCallback: text.statusCallback } : {}),
  });
  const status = (result.status ?? "").toLowerCase();
  if (status === "failed" || status === "undelivered" || status === "canceled") throw new Error("not sent");
  return result.sid;
}

let groupFetch: typeof fetch | undefined;

/** Tests replace the Conversations API. Unset uses the platform fetch. */
export function setCleanerGroupFetch(impl: typeof fetch | undefined): void {
  groupFetch = impl;
}

/**
 * How long the first text in a new group waits before the next one goes. Phones showed the second
 * text (the offer) above the first (the intro) when they went back to back into a new group.
 */
const NEW_GROUP_PAUSE_MS = 6000;
let groupPause: number | undefined;

/** Tests set the pause. Unset pauses only against the real Conversations API. */
export function setCleanerGroupPause(ms: number | undefined): void {
  groupPause = ms;
}

function newGroupPauseMs(): number {
  return groupPause ?? (groupFetch ? 0 : NEW_GROUP_PAUSE_MS);
}

const CONVERSATIONS_ROOT = "https://conversations.twilio.com/v1";
/** The group's own voice. Group texts are posted as this chat participant, and its own echoes are ignored. */
export const CLEANER_GROUP_IDENTITY = "cleaner-core";
export const CLEANER_GROUP_HOOK_PATH = "/webhooks/twilio/cleaner-core/conversation";
/** Group texting allows 10 participants, and one of them is the chat participant. */
const MAX_GROUP_PHONES = 9;

/** Where Twilio posts group replies. Undefined without a public https address. */
export function cleanerGroupHookUrl(env: NodeJS.ProcessEnv): string | undefined {
  // The same base the server checks Twilio's signature against.
  const base = publicBaseUrl(env);
  return base ? `${base}${CLEANER_GROUP_HOOK_PATH}` : undefined;
}

interface Member {
  sid: string;
  identity?: string;
  address?: string;
  proxyAddress?: string;
  projectedAddress?: string;
}

interface GroupApi {
  fetchImpl: typeof fetch;
  auth: string;
}

/**
 * Posts one text to a Twilio group texting conversation
 * (https://www.twilio.com/docs/conversations/group-texting): each phone joins with only its
 * address, one chat participant is projected on the cleaning number, and the text is posted as
 * that participant. The saved group is reused while its people are the same. Otherwise a new one
 * is made and the old one emptied, so an old proxy-style conversation stops capturing one-to-one
 * texts. One person gets a plain text instead. Throws GroupNotConfirmed when the group can't be
 * made or confirmed, so the caller can fall back to one-to-one texts.
 */
export async function sendLiveGroup(
  env: NodeJS.ProcessEnv,
  input: { audience: string[]; body: string; conversationSid?: string },
): Promise<{ sid?: string; conversationSid?: string } | undefined> {
  if (!liveSmsOn(env)) return undefined;
  const audience = [...new Set(input.audience.map((phone) => parsePhone(phone)).filter((phone): phone is string => Boolean(phone)))];
  if (audience.length === 0) return undefined;
  // One of this service's own lines means the group can't be the one the engine asked for.
  if (audience.some((phone) => !mayText(env, phone))) throw new GroupNotConfirmed(input.conversationSid);
  const [only] = audience;
  if (audience.length === 1 && only) {
    // The old group is emptied first, so it can't keep capturing this person's own texts.
    const old = input.conversationSid;
    const api = old ? groupApi(env) : undefined;
    if (old && api) await emptyConversation(api, old).catch(() => undefined);
    const sid = await sendLiveSms(env, { to: only, body: input.body });
    return sid ? { sid } : undefined;
  }
  const hookUrl = cleanerGroupHookUrl(env);
  if (!hookUrl || audience.length > MAX_GROUP_PHONES) throw new GroupNotConfirmed(input.conversationSid);
  const api = groupApi(env);
  const from = parsePhone(env.CLEANER_CORE_TWILIO_PHONE_NUMBER ?? "");
  if (!api || !from) throw new Error("not sent");
  let conversationSid = input.conversationSid;
  let made = false;
  if (!conversationSid || !(await sameGroup(api, conversationSid, audience, from))) {
    if (conversationSid) await emptyConversation(api, conversationSid);
    conversationSid = await makeGroup(api, audience, from, hookUrl);
    made = true;
  }
  // The group is confirmed now. A failed post may still have reached everyone, so it is a plain
  // failure for review, never a group that falls back to one-to-one texts.
  const message = await call(api, conversationPath(conversationSid, "Messages"), { Body: input.body, Author: CLEANER_GROUP_IDENTITY });
  if (!message.sid) throw new Error("not sent");
  // The first text in a new group takes longer to reach phones, so the next one waits for it.
  const pause = made ? newGroupPauseMs() : 0;
  if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  return { sid: message.sid, conversationSid };
}

function groupApi(env: NodeJS.ProcessEnv): GroupApi | undefined {
  const login = cleanerTwilioLogin(env);
  if (!login) return undefined;
  return { fetchImpl: groupFetch ?? fetch, auth: basicAuth(login) };
}

/** True when the conversation is our group texting conversation with exactly these phones. Missing reads as false. */
async function sameGroup(api: GroupApi, conversationSid: string, audience: string[], from: string): Promise<boolean> {
  // A closed or inactive conversation takes no posts, so it is never reused.
  const res = await request(api, "GET", conversationUrl(conversationSid));
  if (res?.status === 404) return false;
  if (!res?.ok) throw new GroupNotConfirmed(conversationSid);
  const conversation = (await res.json().catch(() => undefined)) as { state?: string } | undefined;
  if (conversation?.state !== "active") return false;
  const members = await listMembers(api, conversationSid);
  if (!members) return false;
  const chat = members.filter((member) => !member.address);
  const phones = members.filter((member) => member.address);
  if (chat.length !== 1 || chat[0]?.identity !== CLEANER_GROUP_IDENTITY || parsePhone(chat[0].projectedAddress ?? "") !== from) return false;
  if (phones.some((member) => member.proxyAddress)) return false;
  const addresses = phones.map((member) => member.address);
  return addresses.length === audience.length && new Set(addresses).size === audience.length && audience.every((phone) => addresses.includes(phone));
}

/**
 * A new conversation with its reply webhook, the chat participant, then each phone. Anything that
 * fails empties it, so no half-made group keeps a phone.
 */
async function makeGroup(api: GroupApi, audience: string[], from: string, hookUrl: string): Promise<string> {
  let created: { sid?: string };
  try {
    created = await call(api, `${CONVERSATIONS_ROOT}/Conversations`, { FriendlyName: "Cleaning group" });
  } catch {
    throw new GroupNotConfirmed();
  }
  const sid = created.sid;
  if (!sid) throw new GroupNotConfirmed();
  let refused: RefusedPhone | undefined;
  try {
    await call(api, conversationPath(sid, "Webhooks"), {
      Target: "webhook",
      "Configuration.Url": hookUrl,
      "Configuration.Method": "POST",
      "Configuration.Filters": "onMessageAdded",
    });
    await call(api, conversationPath(sid, "Participants"), { Identity: CLEANER_GROUP_IDENTITY, "MessagingBinding.ProjectedAddress": from });
    for (const phone of audience) {
      try {
        await call(api, conversationPath(sid, "Participants"), { "MessagingBinding.Address": phone });
      } catch (err) {
        // Twilio answered and said no, so the host can be told which number and why.
        if (err instanceof TwilioRefusal) refused = { phone, ...(err.code !== undefined ? { code: err.code } : {}), ...(err.detail ? { message: err.detail } : {}) };
        throw err;
      }
    }
    if (!(await sameGroup(api, sid, audience, from))) throw new GroupNotConfirmed(sid);
  } catch {
    // Kept only when it couldn't be emptied, so the next send empties it.
    const emptied = await emptyConversation(api, sid).then(
      () => true,
      () => false,
    );
    throw new GroupNotConfirmed(emptied ? undefined : sid, refused);
  }
  return sid;
}

/**
 * Deletes a saved group conversation on Twilio, so a Scratch reset leaves nothing that holds the
 * phones or captures their texts. If the delete is refused, its people are removed instead. True
 * when it is gone or empty. False with live texts off, without the Twilio login, or on any failure,
 * so the caller keeps the sid and the next group text replaces it.
 */
export async function deleteLiveGroup(env: NodeJS.ProcessEnv, conversationSid: string): Promise<boolean> {
  if (!liveSmsOn(env)) return false;
  const api = groupApi(env);
  if (!api) return false;
  const res = await request(api, "DELETE", conversationUrl(conversationSid));
  if (res && (res.ok || res.status === 404)) return true;
  return emptyConversation(api, conversationSid).then(
    () => true,
    () => false,
  );
}

/** Removes every participant. A conversation that is already gone counts as empty. */
async function emptyConversation(api: GroupApi, conversationSid: string): Promise<void> {
  const members = await listMembers(api, conversationSid);
  for (const member of members ?? []) {
    const res = await request(api, "DELETE", conversationPath(conversationSid, `Participants/${encodeURIComponent(member.sid)}`));
    if (!res || (!res.ok && res.status !== 404)) throw new GroupNotConfirmed(conversationSid);
  }
}

/** Every participant, page by page. Undefined when the conversation is gone. */
async function listMembers(api: GroupApi, conversationSid: string): Promise<Member[] | undefined> {
  const found: Member[] = [];
  let url: string | undefined = `${conversationPath(conversationSid, "Participants")}?PageSize=50`;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url) || !url.startsWith("https://conversations.twilio.com/")) throw new GroupNotConfirmed(conversationSid);
    seen.add(url);
    const res = await request(api, "GET", url);
    if (res?.status === 404 && found.length === 0) return undefined;
    if (!res?.ok) throw new GroupNotConfirmed(conversationSid);
    const body = (await res.json().catch(() => undefined)) as
      | {
          participants?: { sid?: string; identity?: string | null; messaging_binding?: { address?: string; proxy_address?: string; projected_address?: string } | null }[];
          meta?: { next_page_url?: string | null };
        }
      | undefined;
    if (!body || !Array.isArray(body.participants)) throw new GroupNotConfirmed(conversationSid);
    for (const item of body.participants) {
      if (!item.sid) throw new GroupNotConfirmed(conversationSid);
      const binding = item.messaging_binding ?? {};
      const address = binding.address ? parsePhone(binding.address) : undefined;
      found.push({
        sid: item.sid,
        ...(item.identity ? { identity: item.identity } : {}),
        ...(address ? { address } : {}),
        ...(binding.proxy_address ? { proxyAddress: binding.proxy_address } : {}),
        ...(binding.projected_address ? { projectedAddress: binding.projected_address } : {}),
      });
    }
    const next = body.meta?.next_page_url;
    url = typeof next === "string" && next.length > 0 ? next : undefined;
  }
  return found;
}

function conversationUrl(conversationSid: string): string {
  return `${CONVERSATIONS_ROOT}/Conversations/${encodeURIComponent(conversationSid)}`;
}

function conversationPath(conversationSid: string, tail: string): string {
  return `${conversationUrl(conversationSid)}/${tail}`;
}

/** One API call. Undefined when Twilio couldn't be reached. */
async function request(api: GroupApi, method: string, url: string, fields?: Record<string, string>): Promise<Response | undefined> {
  try {
    return await api.fetchImpl(url, {
      method,
      headers: { Authorization: api.auth, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
    });
  } catch {
    return undefined;
  }
}

/** Twilio answered with an error. Its code and message say why. */
class TwilioRefusal extends Error {
  constructor(
    readonly code?: number,
    readonly detail?: string,
  ) {
    super("not sent");
  }
}

async function refusal(res: Response): Promise<TwilioRefusal> {
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown } | undefined;
    return new TwilioRefusal(typeof body?.code === "number" ? body.code : undefined, typeof body?.message === "string" ? body.message.slice(0, 200) : undefined);
  } catch {
    return new TwilioRefusal();
  }
}

/** A POST whose reply carries a sid. Any failure throws, a TwilioRefusal when Twilio answered. */
async function call(api: GroupApi, url: string, fields: Record<string, string>): Promise<{ sid?: string }> {
  const res = await request(api, "POST", url, fields);
  if (!res) throw new Error("not sent");
  if (!res.ok) throw await refusal(res);
  return ((await res.json().catch(() => ({}))) ?? {}) as { sid?: string };
}
