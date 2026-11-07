import { afterEach, describe, expect, it } from "vitest";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { phoneCodesFor, setPhoneCodes, type CodeSent, type PhoneCodes } from "../src/hosted/phoneCodes";
import { RESEND_MS, SENDS_PER_PHONE_HOUR, SENDS_PER_REQUEST, SIGNUP_WORDS, signUpEmail, signUpPhone, WRONG_CODES_BEFORE_LOCK } from "../src/hosted/signUp";
import { CLEANER_SCOPE, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { BASE, CLEANER_RESOURCE, closeHostedApps, hostedApp, pkce, REDIRECT } from "./cleanerOauthHarness";

/** Sign in and Create account on the connect page (#162). Only 555 numbers; codes come from a fake Verify. */

const HOST = "+15555550161";
const OTHER = "+15555550162";
const LINE = "+15555550170";
const GOOD_CODE = "424242";
const SIGNUP_ENV = {
  CLEANER_CORE_MULTI_TENANT: "1",
  CLEANER_CORE_SIGNUP: "1",
  CLEANER_CORE_TERMS_URL: "https://example.com/property-core/terms",
  CLEANER_CORE_TERMS_VERSION: "2026-11-07",
};

/** Twilio Verify, in memory: every sent phone's code is GOOD_CODE. */
class FakeCodes implements PhoneCodes {
  sent: string[] = [];
  checks: string[] = [];
  next: CodeSent = { sent: true };
  async send(phone: string): Promise<CodeSent> {
    this.sent.push(phone);
    return this.next;
  }
  async check(phone: string, code: string): Promise<boolean> {
    this.checks.push(phone);
    return this.sent.includes(phone) && code === GOOD_CODE;
  }
}

let codes: FakeCodes;

afterEach(() => {
  setPhoneCodes(undefined);
  closeHostedApps();
});

async function signUpApp(extra: NodeJS.ProcessEnv = {}) {
  codes = new FakeCodes();
  setPhoneCodes(codes);
  let clock = Date.now();
  const app = await hostedApp({ ...SIGNUP_ENV, ...extra }, undefined, undefined, () => new Date(clock));
  const registry = new TenantRegistry(app.root, () => new Date());
  const grants = () => new OAuthGrantStore(app.inst.runtime);
  const clientId = await app.register("Grok");
  const page = async (resource = CLEANER_RESOURCE, scope = CLEANER_SCOPE) => {
    const { verifier, challenge } = pkce();
    const res = await app.authorize(clientId, challenge, resource, scope);
    expect(res.status).toBe(200);
    const html = await res.text();
    return { html, verifier, ...app.pageParts(html) };
  };
  const post = (id: string, what: "phone-code" | "approve", body: unknown) =>
    app.http(`/oauth/requests/${id}/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sendCode = (id: string, code: string, phone: string) => post(id, "phone-code", { matchCode: code, phone });
  const message = async (res: { json: () => Promise<unknown> }) => ((await res.json()) as { error?: { message?: string } }).error?.message;
  /** The redirect back to the chat, then the token. */
  const finish = async (id: string, verifier: string) => {
    const back = await app.http(`/oauth/requests/${id}/continue`);
    expect(back.status).toBe(302);
    const code = new URL(back.headers.location!).searchParams.get("code")!;
    const token = await app.http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: CLEANER_RESOURCE }).toString(),
    });
    expect(token.status).toBe(200);
    return grants().findByAccessHash(hashSecret(((await token.json()) as { access_token: string }).access_token))!;
  };
  /** An account the landlord already signed up for. */
  const signedUp = (phone = HOST, label = "Lane", line = LINE) => {
    const { tenant } = registry.create({ label, twilioNumber: line });
    registry.setOwner(tenant.id, { phone, email: "lane@example.com", phoneVerifiedAt: new Date().toISOString(), terms: { version: "2026-11-07", acceptedAt: new Date().toISOString() } });
    return tenant;
  };
  return { app, registry, grants, page, post, sendCode, message, finish, signedUp, tick: (ms: number) => (clock += ms) };
}

describe("the connect page with sign-up", () => {
  it("offers Sign in, Create account and the invite code, with the terms link", async () => {
    const { page } = await signUpApp();
    const { html } = await page();
    expect(html).toContain('value="sign-in" checked');
    expect(html).toContain('value="sign-up"');
    expect(html).toContain('value="invite"');
    expect(html).toContain('id="oauth-phone"');
    expect(html).toContain('href="https://example.com/property-core/terms"');
    expect(html).toContain('id="oauth-invite"');
  });

  it("stays invite-only until the flag, the Verify service and the terms are all set", async () => {
    for (const off of [{ CLEANER_CORE_SIGNUP: "" }, { CLEANER_CORE_TERMS_URL: "" }, { CLEANER_CORE_TERMS_URL: "http://example.com/terms" }, { CLEANER_CORE_TERMS_VERSION: "" }]) {
      const { page } = await signUpApp(off);
      const { html } = await page();
      expect(html).not.toContain("oauth-mode");
      expect(html).toContain('id="oauth-invite"');
    }
    // No Verify service: the real sender needs CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID.
    const { page } = await signUpApp();
    setPhoneCodes(undefined);
    expect((await page()).html).not.toContain("oauth-mode");
  });

  it("refuses a code for the wrong page or a number it can't text", async () => {
    const { page, sendCode, message } = await signUpApp();
    const { id, code } = await page();
    expect((await sendCode(id, "000 000", HOST)).status).toBe(403);
    for (const bad of ["555-0161", "+447700900123", "+15550161", ""]) {
      const res = await sendCode(id, code, bad);
      expect(res.status).toBe(403);
      expect(await message(res)).toBe(SIGNUP_WORDS["bad-phone"]);
    }
    expect(codes.sent).toEqual([]);
  });
});

describe("Sign in", () => {
  it("binds the grant to the account the phone owns, with no invite and no admin step", async () => {
    const { page, sendCode, post, finish, signedUp, registry } = await signUpApp();
    const tenant = signedUp();
    const { id, code, verifier } = await page();
    expect((await sendCode(id, code, "(555) 555-0161")).status).toBe(200);
    expect(codes.sent).toEqual([HOST]);
    expect((await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: "424 242" } })).status).toBe(200);
    const grant = await finish(id, verifier);
    expect(grant).toMatchObject({ tenantId: tenant.id, assistant: "grok" });
    expect(registry.get(tenant.id)!.connections.map((c) => c.grantId)).toEqual([grant.id]);
  });

  it("refuses a phone this page never sent a code to, without asking Twilio", async () => {
    const { page, sendCode, post, message, signedUp, grants } = await signUpApp();
    signedUp();
    signedUp(OTHER, "Court", "+15555550171");
    const { id, code } = await page();
    await sendCode(id, code, OTHER);
    const res = await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: GOOD_CODE } });
    expect(res.status).toBe(403);
    expect(await message(res)).toBe(SIGNUP_WORDS["not-sent"]);
    expect(codes.checks).toEqual([]);
    expect(grants().list()).toHaveLength(0);
  });

  it("locks a phone out for an hour after five wrong codes, even for the right code", async () => {
    const { page, sendCode, post, message, signedUp, tick, grants } = await signUpApp();
    signedUp();
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    for (let i = 1; i < WRONG_CODES_BEFORE_LOCK; i++) {
      const res = await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: "111111" } });
      expect(await message(res)).toBe(SIGNUP_WORDS["wrong-code"]);
    }
    expect(await message(await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: "111111" } }))).toBe(SIGNUP_WORDS.locked);
    expect(await message(await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: GOOD_CODE } }))).toBe(SIGNUP_WORDS.locked);
    expect(await message(await sendCode(id, code, HOST))).toBe(SIGNUP_WORDS.locked);
    expect(grants().list()).toHaveLength(0);
    // An hour later the phone can try again, on a new page.
    tick(60 * 60_000 + 1);
    const again = await page();
    expect((await sendCode(again.id, again.code, HOST)).status).toBe(200);
    expect((await post(again.id, "approve", { matchCode: again.code, signIn: { phone: HOST, code: GOOD_CODE } })).status).toBe(200);
  });

  it("says when the phone has no account, only after its code checks out", async () => {
    const { page, sendCode, post, message } = await signUpApp();
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    expect(await message(await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: "111111" } }))).toBe(SIGNUP_WORDS["wrong-code"]);
    expect(await message(await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: GOOD_CODE } }))).toBe(SIGNUP_WORDS["no-account"]);
  });

  it("refuses a turned-off account", async () => {
    const { page, sendCode, post, message, signedUp, registry, grants } = await signUpApp();
    registry.setDisabled(signedUp().id, true);
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    expect(await message(await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: GOOD_CODE } }))).toBe(SIGNUP_WORDS.disabled);
    expect(grants().list()).toHaveLength(0);
  });

  it("refuses sign-in when sign-up is off", async () => {
    const { page, sendCode, post, signedUp } = await signUpApp({ CLEANER_CORE_SIGNUP: "0" });
    signedUp();
    const { id, code } = await page();
    expect((await sendCode(id, code, HOST)).status).toBe(403);
    expect((await post(id, "approve", { matchCode: code, signIn: { phone: HOST, code: GOOD_CODE } })).status).toBe(403);
    expect(codes.sent).toEqual([]);
  });
});

describe("limits on code texts", () => {
  it("sends one code per phone every 30 seconds and five an hour", async () => {
    const { page, sendCode, message, tick } = await signUpApp();
    let current = await page();
    expect((await sendCode(current.id, current.code, HOST)).status).toBe(200);
    expect(await message(await sendCode(current.id, current.code, HOST))).toBe(SIGNUP_WORDS.wait);
    for (let i = 1; i < SENDS_PER_PHONE_HOUR; i++) {
      tick(RESEND_MS);
      // A new page doesn't reset the phone's own count.
      current = await page();
      expect((await sendCode(current.id, current.code, HOST)).status).toBe(200);
    }
    tick(RESEND_MS);
    current = await page();
    expect(await message(await sendCode(current.id, current.code, HOST))).toBe(SIGNUP_WORDS["too-many-sends"]);
    expect(codes.sent).toHaveLength(SENDS_PER_PHONE_HOUR);
  });

  it("sends at most five codes from one page", async () => {
    const { page, sendCode, message } = await signUpApp();
    const { id, code } = await page();
    for (let i = 0; i < SENDS_PER_REQUEST; i++) expect((await sendCode(id, code, `+1555555018${i}`)).status).toBe(200);
    expect(await message(await sendCode(id, code, "+15555550189"))).toBe(SIGNUP_WORDS["too-many-sends"]);
  });

  it("says so when Twilio won't send", async () => {
    const { page, sendCode, message } = await signUpApp();
    const { id, code } = await page();
    codes.next = { sent: false, why: "bad-number" };
    expect(await message(await sendCode(id, code, HOST))).toBe(SIGNUP_WORDS["send-failed"]);
  });
});

describe("Create account", () => {
  it("checks the email and the terms before spending the code", async () => {
    const { page, sendCode, post, message } = await signUpApp();
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    const base = { phone: HOST, code: GOOD_CODE, email: "lane@example.com", terms: true };
    expect(await message(await post(id, "approve", { matchCode: code, signUp: { ...base, email: "not an email" } }))).toBe(SIGNUP_WORDS["bad-email"]);
    expect(await message(await post(id, "approve", { matchCode: code, signUp: { ...base, terms: false } }))).toBe(SIGNUP_WORDS["no-terms"]);
    expect(await message(await post(id, "approve", { matchCode: code, signUp: { ...base, terms: "yes" } }))).toBe(SIGNUP_WORDS["no-terms"]);
    expect(codes.checks).toEqual([]);
  });

  it("refuses a phone that already has an account", async () => {
    const { page, sendCode, post, message, signedUp, registry } = await signUpApp();
    signedUp();
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    expect(await message(await post(id, "approve", { matchCode: code, signUp: { phone: HOST, code: GOOD_CODE, email: "new@example.com", terms: true } }))).toBe(SIGNUP_WORDS["has-account"]);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses when no text line is free, and creates nothing", async () => {
    const { page, sendCode, post, message, registry, grants } = await signUpApp();
    const { id, code } = await page();
    await sendCode(id, code, HOST);
    expect(await message(await post(id, "approve", { matchCode: code, signUp: { phone: HOST, code: GOOD_CODE, email: "lane@example.com", terms: true } }))).toBe(SIGNUP_WORDS["no-line"]);
    expect(registry.list()).toHaveLength(0);
    expect(grants().list()).toHaveLength(0);
  });
});

describe("invite codes with sign-up on", () => {
  it("still connect an admin-made account", async () => {
    const { app, registry, grants } = await signUpApp();
    const lane = registry.create({ label: "Lane", twilioNumber: LINE });
    const { access } = await app.connect(await app.register("Grok"), CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: lane.inviteCode });
    expect(grants().findByAccessHash(hashSecret(access))).toMatchObject({ tenantId: lane.tenant.id });
  });

  it("work on the shared address too", async () => {
    const { app, registry, grants } = await signUpApp();
    const lane = registry.create({ label: "Lane", twilioNumber: LINE });
    const { access } = await app.connect(await app.register("Grok"), `${BASE}/mcp`, OPERATOR_SCOPE, `${BASE}/mcp`, { inviteCode: lane.inviteCode });
    expect(grants().findByAccessHash(hashSecret(access))).toMatchObject({ tenantId: lane.tenant.id });
  });
});

describe("the account's owner", () => {
  it("is one phone per account", async () => {
    const { registry, signedUp } = await signUpApp();
    signedUp();
    const { tenant } = registry.create({ label: "Court", twilioNumber: "+15555550171" });
    expect(() => registry.setOwner(tenant.id, { phone: HOST, email: "c@example.com", phoneVerifiedAt: "x", terms: { version: "1", acceptedAt: "x" } })).toThrow("owner-taken");
    expect(registry.byOwnerPhone("(555) 555-0161")?.label).toBe("Lane");
    expect(registry.byOwnerPhone(OTHER)).toBeUndefined();
  });
});

describe("sign-up fields", () => {
  it("takes US and Canadian numbers and plain emails", () => {
    expect(signUpPhone("(555) 555-0161")).toBe(HOST);
    expect(signUpPhone("+1 555 555 0161")).toBe(HOST);
    expect(signUpPhone("+15550550161")).toBeUndefined();
    expect(signUpPhone(12)).toBeUndefined();
    expect(signUpEmail(" Lane@Example.com ")).toBe("lane@example.com");
    expect(signUpEmail("lane@example")).toBeUndefined();
    expect(signUpEmail('"><script>@x.com')).toBeUndefined();
  });
});

describe("Twilio Verify", () => {
  // Built at runtime, so no sid-shaped string sits in the repo (publicComplianceBoundaries).
  const ENV = { CLEANER_CORE_TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, CLEANER_CORE_TWILIO_AUTH_TOKEN: "test-token", CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID: `VA${"0".repeat(32)}` };
  const fake = (status: number, body: unknown = {}) => {
    const calls: { url: string; body: string }[] = [];
    const impl = async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return { status, json: async () => body };
    };
    return { calls, impl };
  };

  it("needs the account and a Verify service sid", () => {
    expect(phoneCodesFor({ ...ENV, CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID: "" })).toBeUndefined();
    expect(phoneCodesFor({ ...ENV, CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID: "not-a-sid" })).toBeUndefined();
    expect(phoneCodesFor({ ...ENV, CLEANER_CORE_TWILIO_AUTH_TOKEN: "" })).toBeUndefined();
    expect(phoneCodesFor(ENV)).toBeDefined();
  });

  it("sends by SMS and reads Twilio's refusals", async () => {
    const ok = fake(201, { status: "pending" });
    expect(await phoneCodesFor(ENV, ok.impl)!.send(HOST)).toEqual({ sent: true });
    expect(ok.calls[0]!.url).toBe(`https://verify.twilio.com/v2/Services/VA${"0".repeat(32)}/Verifications`);
    expect(new URLSearchParams(ok.calls[0]!.body).get("To")).toBe(HOST);
    expect(new URLSearchParams(ok.calls[0]!.body).get("Channel")).toBe("sms");
    expect(await phoneCodesFor(ENV, fake(429).impl)!.send(HOST)).toEqual({ sent: false, why: "too-many" });
    expect(await phoneCodesFor(ENV, fake(400, { code: 60203 }).impl)!.send(HOST)).toEqual({ sent: false, why: "too-many" });
    expect(await phoneCodesFor(ENV, fake(400, { code: 60200 }).impl)!.send(HOST)).toEqual({ sent: false, why: "bad-number" });
    expect(await phoneCodesFor(ENV, fake(503).impl)!.send(HOST)).toEqual({ sent: false, why: "unavailable" });
  });

  it("approves only Twilio's approved status", async () => {
    const approved = fake(200, { status: "approved" });
    expect(await phoneCodesFor(ENV, approved.impl)!.check(HOST, GOOD_CODE)).toBe(true);
    expect(approved.calls[0]!.url).toMatch(/\/VerificationCheck$/);
    expect(await phoneCodesFor(ENV, fake(200, { status: "pending" }).impl)!.check(HOST, "111111")).toBe(false);
    expect(await phoneCodesFor(ENV, fake(404).impl)!.check(HOST, GOOD_CODE)).toBe(false);
  });
});
