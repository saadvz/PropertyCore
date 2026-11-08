import { MessagingError } from "../Messenger";

export interface TwilioNumber {
  sid: string;
  phoneNumber: string;
  smsUrl?: string;
}

export interface TwilioSendResult {
  sid: string;
  status?: string;
  errorCode?: number | null;
}

/** The slice of Twilio's REST API Tour Core uses. Tests replace it. */
export interface TwilioClient {
  getAccount(): Promise<{ sid: string; status?: string }>;
  findNumber(e164: string): Promise<TwilioNumber | undefined>;
  setSmsUrl(phoneSid: string, smsUrl: string): Promise<void>;
  sendSms(input: { to: string; from: string; body: string; statusCallback?: string }): Promise<TwilioSendResult>;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export function mapTwilioStatus(status: number): MessagingError {
  if (status === 401 || status === 403) return new MessagingError("TWILIO_AUTH_FAILED", "Twilio didn't accept the account details.", { status });
  if (status === 404) return new MessagingError("TWILIO_NOT_FOUND", "Twilio couldn't find that account or number.", { status });
  if (status === 429) return new MessagingError("TWILIO_RATE_LIMITED", "Twilio is limiting messages right now. Try again shortly.", { status, retryable: true });
  if (status >= 500) return new MessagingError("TWILIO_UNAVAILABLE", "Twilio is having trouble right now.", { status, retryable: true });
  return new MessagingError("TWILIO_REJECTED", "Twilio didn't accept that request.", { status });
}

export function twilioHttpClient(credentials: TwilioCredentials, fetchImpl: FetchLike = fetch as unknown as FetchLike): TwilioClient {
  const root = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}`;
  const auth = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}`;

  async function call(url: string, init?: { method?: string; body?: string }): Promise<unknown> {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetchImpl(url, { method: init?.method ?? "GET", headers: { Authorization: auth, ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: init?.body });
    } catch {
      throw new MessagingError("TWILIO_UNREACHABLE", "Couldn't reach Twilio.", { retryable: true });
    }
    if (res.status >= 400) throw mapTwilioStatus(res.status);
    return res.json().catch(() => ({}));
  }

  return {
    async getAccount() {
      const body = (await call(`${root}.json`)) as { sid?: string; status?: string };
      if (!body.sid) throw new MessagingError("TWILIO_AUTH_FAILED", "Twilio didn't accept the account details.");
      return { sid: body.sid, status: body.status };
    },
    async findNumber(e164) {
      const body = (await call(`${root}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`)) as {
        incoming_phone_numbers?: Array<{ sid?: string; phone_number?: string; sms_url?: string }>;
      };
      const found = body.incoming_phone_numbers?.find((n) => n.phone_number === e164) ?? body.incoming_phone_numbers?.[0];
      if (!found?.sid || !found.phone_number) return undefined;
      return { sid: found.sid, phoneNumber: found.phone_number, ...(found.sms_url ? { smsUrl: found.sms_url } : {}) };
    },
    async setSmsUrl(phoneSid, smsUrl) {
      const body = new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: "POST" });
      await call(`${root}/IncomingPhoneNumbers/${encodeURIComponent(phoneSid)}.json`, { method: "POST", body: body.toString() });
    },
    async sendSms(input) {
      const body = new URLSearchParams({ To: input.to, From: input.from, Body: input.body });
      if (input.statusCallback) body.set("StatusCallback", input.statusCallback);
      const sent = (await call(`${root}/Messages.json`, { method: "POST", body: body.toString() })) as { sid?: string; status?: string; error_code?: number | null };
      if (!sent.sid) throw new MessagingError("TWILIO_REJECTED", "Twilio didn't accept the message.");
      return { sid: sent.sid, status: sent.status, errorCode: sent.error_code };
    },
  };
}
