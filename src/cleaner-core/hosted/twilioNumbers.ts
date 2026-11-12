/**
 * The Twilio REST calls for an account's text line: is the number on the Twilio account, point (or
 * clear) its SMS and voice webhooks, and release it. Credentials are the shared Cleaner Core Twilio account's.
 */

const API = "https://api.twilio.com/2010-04-01";

let fetchImpl: typeof fetch | undefined;

/** Tests replace the network here. */
export function setTwilioNumbersFetch(next: typeof fetch | undefined): void {
  fetchImpl = next;
}

function account(env: NodeJS.ProcessEnv): { sid: string; auth: string } | undefined {
  const sid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const token = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return undefined;
  return { sid, auth: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` };
}

/** The number's sid when it is on the account. Undefined when it isn't, or Twilio can't be reached. */
export async function findIncomingNumber(env: NodeJS.ProcessEnv, e164: string): Promise<{ sid: string } | undefined> {
  const acct = account(env);
  if (!acct) return undefined;
  try {
    const res = await (fetchImpl ?? fetch)(`${API}/Accounts/${acct.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`, {
      method: "GET",
      headers: { Authorization: acct.auth },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { incoming_phone_numbers?: { sid?: string }[] };
    const sid = body.incoming_phone_numbers?.[0]?.sid;
    return typeof sid === "string" ? { sid } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sets the number's SMS and voice webhooks in one call, and clears any TwiML App so the voice webhook
 * takes the calls. Empty strings clear them. True when Twilio accepted it.
 */
export async function pointLineWebhooks(env: NodeJS.ProcessEnv, numberSid: string, urls: { sms: string; voice: string }): Promise<boolean> {
  const acct = account(env);
  if (!acct) return false;
  try {
    const res = await (fetchImpl ?? fetch)(`${API}/Accounts/${acct.sid}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
      method: "POST",
      headers: { Authorization: acct.auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SmsUrl: urls.sms, SmsMethod: "POST", VoiceUrl: urls.voice, VoiceMethod: "POST", VoiceApplicationSid: "" }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Gives the number back to Twilio. It leaves the account, and its business-texting registration with
 * it, for good. True when Twilio released it.
 */
export async function releaseNumber(env: NodeJS.ProcessEnv, numberSid: string): Promise<boolean> {
  const acct = account(env);
  if (!acct) return false;
  try {
    const res = await (fetchImpl ?? fetch)(`${API}/Accounts/${acct.sid}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
      method: "DELETE",
      headers: { Authorization: acct.auth },
    });
    return res.ok;
  } catch {
    return false;
  }
}
