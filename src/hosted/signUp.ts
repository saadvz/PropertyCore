import type { Tenant, TenantOwner, TenantRegistry } from "../cleaner-core/hosted/registry";
import { RegistryError } from "../cleaner-core/hosted/registry";
import { parsePhone } from "../core/phone";
import type { AccountAnswer, AccountDoor } from "../mcp/oauth/provider";
import type { PhoneCodes } from "./phoneCodes";

/**
 * Sign in and Create account on the connect page (saadvz/TourCore#162). A phone code proves the
 * landlord holds their phone; then the grant binds to the account that phone owns, or to a new
 * account with its own text line from the pool. No admin step.
 *
 * Limits live in this process, beside the approval requests they belong to. Twilio Verify keeps its
 * own per-phone limits too, so a restart that clears these still leaves a cap.
 */

/** Each send and check is one of these. */
export type SignUpRefusal =
  | "off"
  | "bad-phone"
  | "not-sent"
  | "wait"
  | "too-many-sends"
  | "busy"
  | "send-failed"
  | "locked"
  | "wrong-code"
  | "no-account"
  | "has-account"
  | "bad-email"
  | "no-terms"
  | "no-line"
  | "disabled";

export const SIGNUP_WORDS: Record<SignUpRefusal, string> = {
  off: "Sign-up isn't open here yet.",
  "bad-phone": "Enter a US mobile number, like (555) 555-0123.",
  "not-sent": "Get a code for that phone first.",
  wait: "A code is on its way. Wait half a minute before asking for another.",
  "too-many-sends": "That's a lot of codes. Try again in an hour.",
  busy: "Too many people are signing up right now. Try again in a few minutes.",
  "send-failed": "The code couldn't be sent. Check the number and try again.",
  locked: "Too many wrong codes for that phone. Try again in an hour.",
  "wrong-code": "That code isn't right, or it expired. Check it, or get a new one.",
  "no-account": "No account has that phone yet. Choose Create account.",
  "has-account": "That phone already has an account. Choose Sign in.",
  "bad-email": "Enter your email address.",
  "no-terms": "Accept the terms to create an account.",
  "no-line": "No text lines are free right now. Try again later, or ask Saad.",
  disabled: "This account is turned off. Ask Saad.",
};

/** One code text at most this often per phone. */
export const RESEND_MS = 30_000;
/** Code texts per phone per hour. */
export const SENDS_PER_PHONE_HOUR = 5;
/** Code texts per connect page. */
export const SENDS_PER_REQUEST = 5;
/** Code texts across the whole service per hour, so one page can't run up the Twilio bill. */
export const SENDS_PER_SERVICE_HOUR = 200;
/** Wrong codes per phone per hour before that phone is locked out for an hour. */
export const WRONG_CODES_BEFORE_LOCK = 5;
const HOUR = 60 * 60_000;

/** The pool's call: creates the account and gives it a ready number in one step. */
export type OpenAccount = (input: { label: string }) => Promise<{ tenant: Tenant } | { refused: "bad-label" | "no-line" }>;

export interface SignUpDeps {
  registry: TenantRegistry;
  /** Undefined when the Verify service isn't set. */
  codes: () => PhoneCodes | undefined;
  /** Undefined until the number pool is wired. Sign-up stays off without it. */
  openAccount?: OpenAccount;
  env: () => NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
}

export interface SignUpTerms {
  url: string;
  version: string;
}

export type Answer = { ok: true; tenantId: string } | { ok: false; refused: SignUpRefusal };

/** On when CLEANER_CORE_SIGNUP is exactly "1" or "true". */
export function signUpFlag(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CLEANER_CORE_SIGNUP?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** The terms a new account accepts: an https page and its version, both set by Saad. */
export function signUpTerms(env: NodeJS.ProcessEnv): SignUpTerms | undefined {
  const url = env.CLEANER_CORE_TERMS_URL?.trim();
  const version = env.CLEANER_CORE_TERMS_VERSION?.trim();
  if (!url || !version || version.length > 40) return undefined;
  try {
    return new URL(url).protocol === "https:" ? { url, version } : undefined;
  } catch {
    return undefined;
  }
}

/** A US or Canadian mobile number in E.164, the only kind the text lines serve. */
export function signUpPhone(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 40) return undefined;
  const phone = parsePhone(raw);
  return phone && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone) ? phone : undefined;
}

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

export function signUpEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim();
  return email.length <= 254 && EMAIL.test(email) ? email.toLowerCase() : undefined;
}

const cleanCode = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\s-]+/g, "") : "");

export class SignUpDesk {
  /** Phones each connect page has sent a code to. */
  private readonly sentFor = new Map<string, { phones: Set<string>; sends: number; at: number }>();
  private readonly phoneSends = new Map<string, number[]>();
  private readonly wrong = new Map<string, number[]>();
  private readonly locked = new Map<string, number>();
  private serviceSends: number[] = [];

  constructor(private readonly deps: SignUpDeps) {}

  /** The terms when sign-up is fully set up: the flag, the Verify service, the terms, and the pool. */
  open(): SignUpTerms | undefined {
    const env = this.deps.env();
    if (!signUpFlag(env) || !this.deps.codes() || !this.deps.openAccount) return undefined;
    return signUpTerms(env);
  }

  async sendCode(requestId: string, rawPhone: unknown): Promise<{ ok: true } | { ok: false; refused: SignUpRefusal }> {
    if (!this.open()) return { ok: false, refused: "off" };
    const codes = this.deps.codes()!;
    const phone = signUpPhone(rawPhone);
    if (!phone) return { ok: false, refused: "bad-phone" };
    const t = this.deps.now();
    this.prune(t);
    if (this.isLocked(phone, t)) return { ok: false, refused: "locked" };
    const page = this.sentFor.get(requestId) ?? { phones: new Set<string>(), sends: 0, at: t };
    if (page.sends >= SENDS_PER_REQUEST) return { ok: false, refused: "too-many-sends" };
    const sends = this.phoneSends.get(phone) ?? [];
    if (sends.length && t - sends[sends.length - 1]! < RESEND_MS) return { ok: false, refused: "wait" };
    if (sends.length >= SENDS_PER_PHONE_HOUR) return { ok: false, refused: "too-many-sends" };
    if (this.serviceSends.length >= SENDS_PER_SERVICE_HOUR) {
      this.deps.log("Sign-up reached its hourly limit of code texts. New codes wait until the hour rolls over.");
      return { ok: false, refused: "busy" };
    }
    // Counted before the send, so a slow Twilio can't be asked twice at once.
    sends.push(t);
    this.phoneSends.set(phone, sends);
    this.serviceSends.push(t);
    page.sends += 1;
    page.at = t;
    this.sentFor.set(requestId, page);
    const result = await codes.send(phone);
    if (!result.sent) {
      this.deps.log(`A sign-up code wasn't sent (${result.why}).`);
      return { ok: false, refused: result.why === "too-many" ? "too-many-sends" : "send-failed" };
    }
    page.phones.add(phone);
    return { ok: true };
  }

  /** Phone and code for an account that phone already owns. */
  async signIn(requestId: string, body: { phone?: unknown; code?: unknown }): Promise<Answer> {
    if (!this.open()) return { ok: false, refused: "off" };
    const checked = await this.checkCode(requestId, body.phone, body.code);
    if (!checked.ok) return checked;
    const tenant = this.deps.registry.byOwnerPhone(checked.phone);
    if (!tenant) return { ok: false, refused: "no-account" };
    if (tenant.disabled) return { ok: false, refused: "disabled" };
    this.deps.log(`A landlord signed in to ${tenant.id} from the connect page.`);
    return { ok: true, tenantId: tenant.id };
  }

  /** Phone and code, email, and the terms: a new account with its own text line. */
  async signUp(requestId: string, body: { phone?: unknown; code?: unknown; email?: unknown; terms?: unknown }): Promise<Answer> {
    const terms = this.open();
    if (!terms) return { ok: false, refused: "off" };
    // The cheap checks first, so a missing tick doesn't spend the code.
    const email = signUpEmail(body.email);
    if (!email) return { ok: false, refused: "bad-email" };
    if (body.terms !== true) return { ok: false, refused: "no-terms" };
    const checked = await this.checkCode(requestId, body.phone, body.code);
    if (!checked.ok) return checked;
    // Said only after the code checks out, so nobody learns which phones have accounts.
    if (this.deps.registry.byOwnerPhone(checked.phone)) return { ok: false, refused: "has-account" };
    const opened = await this.deps.openAccount!({ label: email });
    if ("refused" in opened) return { ok: false, refused: opened.refused === "no-line" ? "no-line" : "bad-email" };
    const at = new Date(this.deps.now()).toISOString();
    const owner: TenantOwner = { phone: checked.phone, email, phoneVerifiedAt: at, terms: { version: terms.version, acceptedAt: at } };
    try {
      this.deps.registry.setOwner(opened.tenant.id, owner);
    } catch (err) {
      // Two pages for one phone at once: the other one won. This account keeps its line for /admin to close.
      if (err instanceof RegistryError && err.reason === "owner-taken") {
        this.deps.log(`Sign-up opened ${opened.tenant.id}, but its phone signed up on another page first. Close ${opened.tenant.id} on /admin.`);
        return { ok: false, refused: "has-account" };
      }
      throw err;
    }
    this.deps.log(`A landlord created ${opened.tenant.id} from the connect page.`);
    return { ok: true, tenantId: opened.tenant.id };
  }

  private async checkCode(requestId: string, rawPhone: unknown, rawCode: unknown): Promise<{ ok: true; phone: string } | { ok: false; refused: SignUpRefusal }> {
    const phone = signUpPhone(rawPhone);
    if (!phone) return { ok: false, refused: "bad-phone" };
    const t = this.deps.now();
    this.prune(t);
    if (this.isLocked(phone, t)) return { ok: false, refused: "locked" };
    // Only a phone this page sent a code to, so the check can't be tried for any phone at all.
    if (!this.sentFor.get(requestId)?.phones.has(phone)) return { ok: false, refused: "not-sent" };
    const code = cleanCode(rawCode);
    const good = /^\d{4,10}$/.test(code) && (await this.deps.codes()?.check(phone, code)) === true;
    if (good) {
      this.wrong.delete(phone);
      return { ok: true, phone };
    }
    const misses = [...(this.wrong.get(phone) ?? []), t];
    this.wrong.set(phone, misses);
    if (misses.length >= WRONG_CODES_BEFORE_LOCK) {
      this.locked.set(phone, t + HOUR);
      this.wrong.delete(phone);
      this.deps.log("A phone was locked out of sign-in for an hour after too many wrong codes.");
      return { ok: false, refused: "locked" };
    }
    return { ok: false, refused: "wrong-code" };
  }

  private isLocked(phone: string, t: number): boolean {
    const until = this.locked.get(phone);
    return until !== undefined && until > t;
  }

  private prune(t: number): void {
    const recent = (times: number[]) => times.filter((at) => t - at < HOUR);
    this.serviceSends = recent(this.serviceSends);
    for (const [phone, times] of this.phoneSends) {
      const kept = recent(times);
      if (kept.length) this.phoneSends.set(phone, kept);
      else this.phoneSends.delete(phone);
    }
    for (const [phone, times] of this.wrong) {
      const kept = recent(times);
      if (kept.length) this.wrong.set(phone, kept);
      else this.wrong.delete(phone);
    }
    for (const [phone, until] of this.locked) if (until <= t) this.locked.delete(phone);
    // An approval request lives 10 minutes; its sends are kept an hour, like the rest.
    for (const [id, page] of this.sentFor) if (t - page.at >= HOUR) this.sentFor.delete(id);
  }
}

/** The connect page's account door: the desk's answers in the page's words. */
export function accountDoor(desk: SignUpDesk): AccountDoor {
  const said = <T extends { ok: boolean }>(answer: T | { ok: false; refused: SignUpRefusal }) =>
    answer.ok ? (answer as T) : { ok: false as const, message: SIGNUP_WORDS[(answer as { refused: SignUpRefusal }).refused] };
  return {
    open: () => {
      const terms = desk.open();
      return terms ? { termsUrl: terms.url } : undefined;
    },
    sendCode: async (requestId, phone) => said(await desk.sendCode(requestId, phone)),
    signIn: async (requestId, body) => said(await desk.signIn(requestId, body)) as AccountAnswer,
    signUp: async (requestId, body) => said(await desk.signUp(requestId, body)) as AccountAnswer,
  };
}
