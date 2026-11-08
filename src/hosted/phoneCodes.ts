/**
 * The code that proves a landlord holds their phone, on the connect page. Twilio Verify sends and
 * checks it, so the service never stores the code and doesn't need a registered line of its own to
 * text from: Verify's senders are already registered. The account is the shared Cleaner Core
 * Twilio account; the Verify service is CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID.
 */

const VERIFY = "https://verify.twilio.com/v2/Services";
const SERVICE_SID = /^VA[0-9a-f]{32}$/i;

export type CodeSent = { sent: true } | { sent: false; why: "bad-number" | "too-many" | "unavailable" };
/** Unavailable when Twilio couldn't answer, so a landlord isn't charged a miss for it. */
export type CodeChecked = "approved" | "denied" | "unavailable";

/** Sends and checks the phone code. Tests replace it with a fake. */
export interface PhoneCodes {
  send(phone: string): Promise<CodeSent>;
  /** Approved only when Twilio approved this code for this phone. */
  check(phone: string, code: string): Promise<CodeChecked>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

let override: PhoneCodes | undefined;

/** Tests replace the phone code sender here. Unset uses Twilio Verify. */
export function setPhoneCodes(next: PhoneCodes | undefined): void {
  override = next;
}

/** The Verify service's sid, when it is set and has a Verify sid's shape. */
export function verifyServiceSid(env: NodeJS.ProcessEnv): string | undefined {
  const sid = env.CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID?.trim();
  return sid && SERVICE_SID.test(sid) ? sid : undefined;
}

export function phoneCodesFor(env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch as unknown as FetchLike): PhoneCodes | undefined {
  if (override) return override;
  const service = verifyServiceSid(env);
  const sid = env.CLEANER_CORE_TWILIO_ACCOUNT_SID?.trim();
  const token = env.CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim();
  if (!service || !sid || !token) return undefined;
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  const post = async (path: string, fields: Record<string, string>) =>
    fetchImpl(`${VERIFY}/${encodeURIComponent(service)}/${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  return {
    async send(phone) {
      try {
        const res = await post("Verifications", { To: phone, Channel: "sms" });
        if (res.status === 201 || res.status === 200) return { sent: true };
        // 60200 is a number Twilio can't text; 60203 and 429 are Twilio's own send limits.
        const body = (await res.json().catch(() => ({}))) as { code?: number };
        if (res.status === 429 || body.code === 60203) return { sent: false, why: "too-many" };
        if (res.status === 400) return { sent: false, why: "bad-number" };
        return { sent: false, why: "unavailable" };
      } catch {
        return { sent: false, why: "unavailable" };
      }
    },
    async check(phone, code) {
      try {
        const res = await post("VerificationCheck", { To: phone, Code: code });
        // 404: no code is waiting for that phone (expired, already used, or Twilio's own attempt limit).
        if (res.status === 404 || res.status === 400) return "denied";
        if (res.status !== 200) return "unavailable";
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        return body.status === "approved" ? "approved" : "denied";
      } catch {
        return "unavailable";
      }
    },
  };
}
