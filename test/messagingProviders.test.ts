import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Installation } from "../src/install/installation";
import { MessagingLedger } from "../src/messaging/ledger";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { PhotonMessagingProvider, type PhotonEnv } from "../src/messaging/photon/provider";
import type { PhotonClient, PhotonLine } from "../src/messaging/photon/client";
import { verifyLegacySpectrumSignature, verifyStandardWebhook } from "../src/messaging/photon/signature";
import { consentModeForProvider, providerConsentRecommendation, resolveConsentMode } from "../src/messaging/consentPolicy";
import { ensureMessagingSelection, resolveMessagingSelection } from "../src/messaging/registry";
import { SendblueMessagingProvider } from "../src/messaging/sendblue/provider";
import { setSendblueRuntime, type SendblueEnv } from "../src/messaging/sendblue/runtime";
import { setTwilioClient, TwilioMessagingProvider, readTwilioEnv, type TwilioEnv } from "../src/messaging/twilio/provider";
import type { TwilioClient } from "../src/messaging/twilio/client";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { MessagingError } from "../src/messaging/Messenger";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, LINE, PUBLIC, SECRET, sendblueEnv } from "./fakeSendblue";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { installHarness, SB_KEY, SB_SECRET } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const TWILIO_SID = "AC1234567890abcdef1234567890abcd";
const TWILIO_TOKEN = "twilio-auth-token-SECRET-999999";
const TWILIO_NUMBER = "+15555550123";
const VISITOR = "+15555550100";
const PHOTON_ID = "11111111-1111-4111-8111-111111111111";
const PHOTON_SECRET = "photon-project-secret-SECRET-8888";

function twilioEnv(overrides: Partial<TwilioEnv> = {}): TwilioEnv {
  return {
    accountSid: TWILIO_SID,
    authToken: TWILIO_TOKEN,
    fromNumber: TWILIO_NUMBER,
    fromNumberRaw: TWILIO_NUMBER,
    publicBaseUrl: PUBLIC,
    publicBaseUrlRaw: PUBLIC,
    ...overrides,
  };
}

function photonEnv(overrides: Partial<PhotonEnv> = {}): PhotonEnv {
  return {
    projectId: PHOTON_ID,
    projectSecret: PHOTON_SECRET,
    signingSecret: "photon-signing-secret",
    standardSigningSecret: "whsec_" + Buffer.from("photon-standard-secret").toString("base64"),
    publicBaseUrl: PUBLIC,
    publicBaseUrlRaw: PUBLIC,
    ...overrides,
  };
}

function fakeTwilio(options: { missingNumber?: boolean; down?: boolean; sendStatus?: string } = {}): TwilioClient & { sent: Array<{ to: string; body: string }> } {
  const sent: Array<{ to: string; body: string }> = [];
  const client: TwilioClient & { sent: typeof sent } = {
    sent,
    async getAccount() {
      if (options.down) throw new MessagingError("TWILIO_UNAVAILABLE", "Twilio is having trouble right now.", { retryable: true });
      return { sid: TWILIO_SID, status: "active" };
    },
    async findNumber() {
      if (options.missingNumber) return undefined;
      return { sid: "PN123", phoneNumber: TWILIO_NUMBER, smsUrl: `${PUBLIC}/webhooks/twilio` };
    },
    async setSmsUrl() {},
    async sendSms(input) {
      if (options.down) throw new MessagingError("TWILIO_UNAVAILABLE", `down ${TWILIO_TOKEN}`, { retryable: true });
      sent.push({ to: input.to, body: input.body });
      return { sid: `SM${sent.length}`, status: options.sendStatus ?? "queued" };
    },
  };
  return client;
}

function fakePhoton(options: { lines?: PhotonLine[]; type?: "shared" | "dedicated"; down?: boolean; auth?: boolean } = {}): PhotonClient & { sent: string[]; registered: string[] } {
  const sent: string[] = [];
  const registered: string[] = [];
  const lines = options.lines ?? [{ id: "line-1", phoneNumber: "+15555550123", status: "available" as const }];
  const client: PhotonClient & { sent: string[]; registered: string[] } = {
    sent,
    registered,
    async getProject() {
      if (options.auth) throw new MessagingError("PHOTON_AUTH_FAILED", "Photon didn't accept the project details.");
      if (options.down) throw new MessagingError("PHOTON_UNAVAILABLE", "Photon is having trouble right now.", { retryable: true });
      return { name: "Tour Core" };
    },
    async getImessageInfo() {
      return { type: options.type ?? "dedicated" };
    },
    async listLines() {
      return lines;
    },
    async listWebhooks() {
      return registered.map((url, i) => ({ id: `wh_${i}`, webhookUrl: url, status: "active" }));
    },
    async registerWebhook(url) {
      registered.push(url);
      return { id: "wh_new", signingSecret: "signing-secret", standardSigningSecret: "whsec_new" };
    },
    async deleteWebhook() {},
    async rotateStandardSecret() {
      return { standardSigningSecret: "whsec_rotated" };
    },
    async sendText(input) {
      if (options.down) throw new MessagingError("PHOTON_UNAVAILABLE", `down ${PHOTON_SECRET}`, { retryable: true });
      sent.push(input.text);
      return { providerMessageId: `spc-msg-${sent.length}` };
    },
  };
  return client;
}

function form(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString());
}

describe("messaging provider contract", () => {
  it("Sendblue, Twilio, and Photon share validation, inbound text, send, ids, duplicates, failure, and redaction", async () => {
    const ledger = new MessagingLedger();
    const sendblueFake = fakeSendblue();
    cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => sendblueFake.client }));
    const twilio = fakeTwilio();
    const photon = fakePhoton();
    const providers = [
      new SendblueMessagingProvider({ ledger }),
      new TwilioMessagingProvider({ env: () => twilioEnv(), client: twilio, ledger }),
      new PhotonMessagingProvider({ env: () => photonEnv({ fromNumber: "+15555550123", fromNumberRaw: "+15555550123" }), client: photon, ledger }),
    ];

    for (const provider of providers) {
      expect(provider.validateConfiguration().ok).toBe(true);
      expect(provider.capabilities().outboundMessaging).toBe(true);
      const receipt = await provider.send({ to: VISITOR, body: "Hello", audience: "PROSPECT", idempotencyKey: "once" });
      expect(receipt.providerMessageId).toBeTruthy();
      expect(receipt.provider).toBe(provider.id);
      const again = await provider.send({ to: VISITOR, body: "Hello", audience: "PROSPECT", idempotencyKey: "once" });
      expect(again.providerMessageId).toBe(receipt.providerMessageId);
    }

    const blankTwilio = new TwilioMessagingProvider({ env: () => twilioEnv({ accountSid: undefined, authToken: undefined, fromNumberRaw: undefined }) });
    expect(blankTwilio.validateConfiguration().ok).toBe(false);
    const wrong = new TwilioMessagingProvider({ env: () => twilioEnv(), client: fakeTwilio({ missingNumber: true }) });
    expect((await wrong.check()).find((c) => c.id === "line")?.ok).toBe(false);

    const down = new TwilioMessagingProvider({ env: () => twilioEnv(), client: fakeTwilio({ down: true }) });
    await expect(down.send({ to: VISITOR, body: "Hi", audience: "PROSPECT" })).rejects.toBeInstanceOf(MessagingError);
    try {
      await down.send({ to: VISITOR, body: "Hi", audience: "PROSPECT" });
    } catch (err) {
      expect((err as Error).message).not.toContain(TWILIO_TOKEN);
    }

    const photonDown = new PhotonMessagingProvider({ env: () => photonEnv(), client: fakePhoton({ down: true }) });
    try {
      await photonDown.send({ to: VISITOR, body: "Hi", audience: "PROSPECT" });
    } catch (err) {
      expect((err as Error).message).not.toContain(PHOTON_SECRET);
    }
  });
});

describe("Twilio adapter", () => {
  it("in a touring process, checks and keeps the shared service's incoming address, never its own", async () => {
    const shared = "https://shared.up.railway.app/webhooks/twilio/cleaner-core";
    const env = readTwilioEnv({
      TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER",
      TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID,
      TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER,
      PUBLIC_BASE_URL: "https://shared.up.railway.app/t/tnt_lane000001",
      TOURCORE_TWILIO_INCOMING_URL: shared,
    });
    const pointed: string[] = [];
    const client = { ...fakeTwilio(), findNumber: async () => ({ sid: "PN123", phoneNumber: TWILIO_NUMBER, smsUrl: shared }), setSmsUrl: async (_sid: string, url: string) => void pointed.push(url) };
    const provider = new TwilioMessagingProvider({ env: () => env, client });
    expect((await provider.check()).find((c) => c.id === "incoming")).toMatchObject({ ok: true });
    const connected = await provider.connect({} as never);
    expect(connected.webhook).toBe("already-registered");
    expect(pointed).toEqual([]);
    // Outside a touring process the setting means nothing.
    expect(readTwilioEnv({ TOURCORE_TWILIO_INCOMING_URL: shared }).incomingUrl).toBeUndefined();
  });

  const url = `${PUBLIC}/webhooks/twilio`;
  const fields = { MessageSid: "SM123", From: VISITOR, To: TWILIO_NUMBER, Body: "Hi", SmsStatus: "received" };

  it("parses form bodies, checks signatures, normalizes the message, and ignores a duplicate", async () => {
    const raw = form(fields);
    const signature = createHmac("sha1", TWILIO_TOKEN)
      .update(url + Object.keys(fields).sort().reduce((acc, key) => acc + key + fields[key as keyof typeof fields], ""))
      .digest("base64");
    expect(signature).toBe(twilioSignature(TWILIO_TOKEN, url, fields));
    const provider = new TwilioMessagingProvider({ env: () => twilioEnv() });
    expect(provider.verifyWebhook({ rawBody: raw, headers: { "x-twilio-signature": signature }, url })).toEqual({ ok: true, signed: true });
    expect(provider.verifyWebhook({ rawBody: raw, headers: { "x-twilio-signature": "nope" }, url }).ok).toBe(false);
    expect(provider.parseInbound(raw).message).toMatchObject({ provider: "twilio", providerMessageId: "SM123", from: VISITOR, to: TWILIO_NUMBER, text: "Hi", channel: "SMS" });

    const ledger = new MessagingLedger();
    const client = fakeTwilio();
    const live = new TwilioMessagingProvider({ env: () => twilioEnv(), client, ledger });
    let calls = 0;
    const deliver = () => handleProviderWebhook(live, { rawBody: raw, headers: { "x-twilio-signature": signature }, url }, { ledger, receive: async () => { calls += 1; } });
    expect((await deliver()).body).toEqual({ ok: true });
    expect((await deliver()).body).toEqual({ duplicate: true });
    expect(calls).toBe(1);
    expect(ledger.duplicatesOf("twilio:SM123")).toBe(1);
  });

  it("stores a canceled Twilio send as failed", async () => {
    const provider = new TwilioMessagingProvider({ env: () => twilioEnv(), client: fakeTwilio({ sendStatus: "canceled" }) });
    const receipt = await provider.send({ to: VISITOR, body: "Booked", audience: "PROSPECT" });
    expect(receipt.status).toBe("FAILED");
  });

  it("rejects a delivery-status callback as a visitor message and sends outbound SMS with the provider id", async () => {
    const provider = new TwilioMessagingProvider({ env: () => twilioEnv(), client: fakeTwilio() });
    const status = form({ MessageSid: "SM999", MessageStatus: "delivered", From: TWILIO_NUMBER, To: VISITOR });
    expect(provider.parseInbound(status)).toEqual({ ignored: "delivery status" });
    const receipt = await provider.send({ to: VISITOR, body: "Booked", audience: "PROSPECT" });
    expect(receipt).toMatchObject({ provider: "twilio", providerMessageId: "SM1", channel: "SMS" });
  });
});

describe("Photon adapter", () => {
  it("validates lines, normalizes inbound text, sends, and rejects a bad signature", async () => {
    const dedicated = fakePhoton({ lines: [
      { id: "a", phoneNumber: "+15555550123", status: "available" },
      { id: "b", phoneNumber: "+15555550124", status: "available" },
    ] });
    const undecided = new PhotonMessagingProvider({ env: () => photonEnv(), client: dedicated });
    const choice = await undecided.connect({ saveSecret: () => {} });
    expect(choice.needsLineChoice).toBe(true);
    expect(choice.ok).toBe(false);

    const missing = new PhotonMessagingProvider({ env: () => photonEnv({ fromNumber: "+15555550999", fromNumberRaw: "+15555550999" }), client: dedicated });
    expect((await missing.check()).some((c) => c.code === "PHOTON_LINE_NOT_FOUND")).toBe(true);

    const shared = new PhotonMessagingProvider({ env: () => photonEnv(), client: fakePhoton({ type: "shared", lines: [] }) });
    expect((await shared.check()).find((c) => c.id === "line")).toMatchObject({ ok: true });
    expect(shared.capabilities().sharedLine).toBe(true);
    expect(shared.capabilities().dedicatedLine).toBe(false);

    const selected = new PhotonMessagingProvider({
      env: () => photonEnv({ fromNumber: "+15555550123", fromNumberRaw: "+15555550123" }),
      client: fakePhoton(),
    });
    expect((await selected.check()).every((c) => c.id === "incoming" || c.ok || c.id === "verify-link")).toBe(true);
    const raw = Buffer.from(JSON.stringify({
      event: "messages",
      space: { id: "any;-;+15555550100", platform: "iMessage", type: "dm", phone: "+15555550123" },
      message: { id: "spc-msg-1", timestamp: "2026-10-02T12:00:00.000Z", sender: { id: VISITOR, platform: "iMessage" }, content: { type: "text", text: "Hi" } },
    }));
    const secret = "photon-signing-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex");
    expect(verifyLegacySpectrumSignature(raw, secret, signature, timestamp).ok).toBe(true);
    expect(selected.verifyWebhook({ rawBody: raw, headers: { "x-spectrum-signature": signature, "x-spectrum-timestamp": timestamp } }).ok).toBe(true);
    expect(selected.verifyWebhook({ rawBody: raw, headers: { "x-spectrum-signature": "v0=00", "x-spectrum-timestamp": timestamp } }).ok).toBe(false);
    expect(selected.parseInbound(raw)).toMatchObject({ message: { provider: "photon", providerMessageId: "spc-msg-1", from: VISITOR, to: "+15555550123", text: "Hi", channel: "IMESSAGE" } });

    const ledger = new MessagingLedger();
    const client = fakePhoton();
    const live = new PhotonMessagingProvider({ env: () => photonEnv({ fromNumber: "+15555550123", fromNumberRaw: "+15555550123" }), client, ledger });
    let calls = 0;
    const request = { rawBody: raw, headers: { "x-spectrum-signature": signature, "x-spectrum-timestamp": timestamp } };
    expect((await handleProviderWebhook(live, request, { ledger, receive: async () => { calls += 1; } })).body).toEqual({ ok: true });
    expect((await handleProviderWebhook(live, request, { ledger, receive: async () => { calls += 1; } })).body).toEqual({ duplicate: true });
    expect(calls).toBe(1);
    const receipt = await live.send({ to: VISITOR, body: "Hello", audience: "PROSPECT" });
    expect(receipt.providerMessageId).toBe("spc-msg-1");
    expect(client.sent).toEqual(["Hello"]);

    const standardSecret = "whsec_" + Buffer.from("standard-key-material").toString("base64");
    const id = "msg_1";
    const expected = createHmac("sha256", Buffer.from("standard-key-material")).update(`${id}.${timestamp}.`).update(raw).digest("base64");
    expect(verifyStandardWebhook(raw, standardSecret, id, timestamp, `v1,${expected}`).ok).toBe(true);
  });

  it("fails closed without credentials and when Photon is down", async () => {
    expect(new PhotonMessagingProvider({ env: () => photonEnv({ projectId: undefined, projectSecret: undefined }) }).validateConfiguration().ok).toBe(false);
    const down = new PhotonMessagingProvider({ env: () => photonEnv(), client: fakePhoton({ down: true }) });
    expect((await down.check()).find((c) => c.id === "account")?.ok).toBe(false);
    await expect(down.send({ to: VISITOR, body: "Hi", audience: "PROSPECT" })).rejects.toBeInstanceOf(MessagingError);
  });
});

describe("installation messaging status", () => {
  it("is not configured until a provider is chosen, then connected only after a passing test", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    const none = await h.status();
    expect(none.components.find((c) => c.component === "VISITOR_MESSAGING")).toMatchObject({ state: "NOT_CONFIGURED" });
    expect(JSON.stringify(none)).toContain("provider=none status=NOT_CONFIGURED");
    const unset = none.components.find((c) => c.component === "VISITOR_MESSAGING");
    expect(unset?.next).toMatchObject({ action: "CHOOSE_MESSAGING_PROVIDER", operatorMessage: "How would you like prospects to text Tour Core?" });
    expect(JSON.stringify(unset?.next)).not.toMatch(/Sendblue API|secure setup page|\/install/);

    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE });
    const pending = await h.status();
    expect(pending.components.find((c) => c.component === "VISITOR_MESSAGING")?.state).toBe("ACTION_REQUIRED");
    expect(JSON.stringify(pending)).toContain("provider=sendblue status=NEEDS_ACTION");

    const fake = fakeSendblue({ hooks: [{ url: `${PUBLIC}/webhooks/sendblue`, secret: SECRET }], lines: [{ sendblue_number: LINE, status: "ONLINE" }] });
    cleanups.push(setSendblueRuntime({ env: () => h.inst.sendblueEnv(), client: () => fake.client }));
    h.inst.secrets.set({ SENDBLUE_WEBHOOK_SECRET: SECRET });
    const tested = await h.ok("test_visitor_messaging");
    expect(tested.ok).toBe(true);
    const ready = await h.status();
    expect(ready.components.find((c) => c.component === "VISITOR_MESSAGING")).toMatchObject({ state: "READY" });
    expect(JSON.stringify(ready)).toContain("provider=sendblue status=CONNECTED");
    expect(JSON.stringify(ready)).not.toContain(SB_KEY);
  });

  it("migrates a legacy Sendblue install once and does not switch it to Twilio", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
    h.inst.files.update({ messagingProvider: "SENDBLUE" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE });
    const selection = ensureMessagingSelection(h.inst);
    expect(selection.provider).toBe("sendblue");
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
    expect(h.inst.files.state().messagingProviderChoice).toBe("sendblue");
    const messaging = (await h.status()).components.find((c) => c.component === "VISITOR_MESSAGING");
    expect(messaging?.next?.action).not.toBe("CHOOSE_MESSAGING_PROVIDER");
  });

  it("rejects an unknown provider name", () => {
    const selection = resolveMessagingSelection({ env: { TOURCORE_MESSAGING_PROVIDER: "linq" }, sendblue: sendblueEnv({ apiKey: undefined, apiSecret: undefined, fromNumber: undefined, fromNumberRaw: undefined }) });
    expect(selection.invalid).toBe("linq");
    expect(selection.readiness).toBe("NEEDS_ACTION");
  });

  it("switching providers keeps saved credentials, clears the connection test, and requires a new test", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "sendblue" });
    const { config } = h.workspace.save(hillsideConfig());
    h.workspace.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(h.now()) }));

    const switched = await h.ok("choose_messaging_provider", { provider: "twilio" });
    expect(switched.summary).toMatch(/I'll ask for the account details securely/);
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")).toBe(SECRET);
    expect(h.inst.files.state().visitorMessaging).toBeUndefined();
    expect(h.inst.files.manifest()?.messagingProvider).toBe("TWILIO");
    expect(h.workspace.load(config.property.id).state.readiness?.passed).toBe(false);
    const status = await h.status();
    expect(status.components.find((c) => c.component === "VISITOR_MESSAGING")?.state).not.toBe("READY");
    expect(JSON.stringify(status)).toContain("provider=twilio status=NEEDS_ACTION");
    expect(status.components.find((c) => c.component === "VISITOR_MESSAGING")?.next).toMatchObject({ action: "CONNECT_VISITOR_MESSAGING" });

    const back = await h.ok("choose_messaging_provider", { provider: "sendblue" });
    expect(back.summary).toMatch(/I'll test the saved account next/);
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    const restored = await h.status();
    expect(restored.components.find((c) => c.component === "VISITOR_MESSAGING")?.next).toMatchObject({ action: "TEST_VISITOR_MESSAGING" });
    expect(JSON.stringify(restored)).not.toMatch(/I'll ask for them securely/);
  });

  it("switching to local and back to Sendblue keeps the stored account and line", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", problems: [], publicBaseUrl: PUBLIC, provider: "sendblue" });

    const toLocal = await h.ok("choose_messaging_provider", { provider: "local" });
    expect(toLocal.summary).toMatch(/local loopback/i);
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")).toBe(SECRET);
    expect(h.inst.files.state().visitorMessaging).toBeUndefined();
    expect(h.inst.files.manifest()?.messagingProvider).toBe("LOCAL");

    const back = await h.ok("choose_messaging_provider", { provider: "sendblue" });
    expect(back.summary).toBe("Visitor texting will use Sendblue. I'll test the saved account next.");
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")).toBe(SECRET);
    const messaging = (await h.status()).components.find((c) => c.component === "VISITOR_MESSAGING");
    expect(messaging?.next).toMatchObject({ action: "TEST_VISITOR_MESSAGING" });
    expect(messaging?.next?.action).not.toBe("CONNECT_VISITOR_MESSAGING");
  });

  it("switching providers keeps Twilio and Photon credentials and the chosen Photon line", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "twilio" });
    h.inst.secrets.set({
      TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID,
      TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER,
      TOURCORE_PHOTON_PROJECT_ID: PHOTON_ID,
      TOURCORE_PHOTON_PROJECT_SECRET: PHOTON_SECRET,
      TOURCORE_PHOTON_PHONE_NUMBER: "+15555550123",
    });
    h.inst.files.writeState({
      ...h.inst.files.state(),
      messagingLines: [{ id: "a", address: "+15555550123", status: "available" }],
    });

    await h.ok("choose_messaging_provider", { provider: "local" });
    expect(h.inst.secrets.get("TOURCORE_TWILIO_ACCOUNT_SID")).toBe(TWILIO_SID);
    expect(h.inst.secrets.get("TOURCORE_TWILIO_AUTH_TOKEN")).toBe(TWILIO_TOKEN);
    expect(h.inst.secrets.get("TOURCORE_TWILIO_PHONE_NUMBER")).toBe(TWILIO_NUMBER);
    expect(h.inst.secrets.get("TOURCORE_PHOTON_PROJECT_ID")).toBe(PHOTON_ID);
    expect(h.inst.secrets.get("TOURCORE_PHOTON_PROJECT_SECRET")).toBe(PHOTON_SECRET);
    expect(h.inst.secrets.get("TOURCORE_PHOTON_PHONE_NUMBER")).toBe("+15555550123");
    expect(h.inst.files.state().messagingLines?.map((line) => line.address)).toEqual(["+15555550123"]);

    const toPhoton = await h.ok("choose_messaging_provider", { provider: "photon" });
    expect(toPhoton.summary).toMatch(/I'll test the saved account next/);
    expect(h.inst.secrets.get("TOURCORE_PHOTON_PHONE_NUMBER")).toBe("+15555550123");
    expect(h.inst.secrets.get("TOURCORE_TWILIO_AUTH_TOKEN")).toBe(TWILIO_TOKEN);
    expect(h.inst.files.state().messagingLines?.map((line) => line.address)).toEqual(["+15555550123"]);
  });

  it("set_services live or demo does not wipe installation messaging secrets", async () => {
    const h = installHarness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: SECRET });
    const { config } = h.workspace.save(hillsideConfig());

    await h.ok("set_services", { property: config.property.id, messaging: "demo" });
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    await h.ok("set_services", { property: config.property.id, messaging: "sendblue" });
    expect(h.inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(h.inst.secrets.get("SENDBLUE_API_API_SECRET")).toBe(SB_SECRET);
    expect(h.inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBe(LINE);
    expect(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")).toBe(SECRET);
    expect(h.inst.files.manifest()?.messagingProvider).toBe("SENDBLUE");
  });
});

describe("fresh Grok messaging setup", () => {
  async function choose(provider: "sendblue" | "twilio" | "photon") {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" } });
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    const step = await h.ok("get_next_installation_step");
    // Public endpoint and Grok may come first. Walk until the messaging choice.
    let current = step;
    for (let i = 0; i < 6 && current.action !== "CHOOSE_MESSAGING_PROVIDER"; i++) {
      if (current.action === "ESTABLISH_PUBLIC_ENDPOINT" || current.action === "CHECK_PUBLIC_ENDPOINT") {
        h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at: new Date(h.now()).toISOString(), message: "ok", url: PUBLIC });
      } else if (current.action === "CONNECT_GROK") h.connectGrok();
      current = await h.ok("get_next_installation_step");
    }
    expect(current.operatorMessage).toMatch(/How would you like prospects to text Tour Core/);
    expect(JSON.stringify(current)).not.toMatch(/Sendblue API|secure setup page|\/install/);
    expect(current.choices.map((c: { id: string }) => c.id)).toEqual(["sendblue", "twilio", "photon"]);
    const chosen = await h.ok("choose_messaging_provider", { provider });
    expect(JSON.stringify(chosen)).not.toContain(SB_SECRET);
    expect(JSON.stringify(chosen)).not.toContain(TWILIO_TOKEN);
    expect(JSON.stringify(chosen)).not.toContain(PHOTON_SECRET);
    const next = await h.ok("get_next_installation_step");
    expect(next.action).toBe("CONNECT_VISITOR_MESSAGING");
    const asks = {
      sendblue: /Sendblue needs your API key, API secret, and messaging number\. I'll ask for them securely; they won't be shown to me in chat\./,
      twilio: /Twilio needs your Account SID, Auth Token, and Tour Core phone number\. I'll ask for them securely; they won't be shown to me in chat\./,
      photon: /Photon needs your project credentials\. I'll ask for them securely; they won't be shown to me in chat\./,
    };
    expect(next.operatorMessage).toMatch(asks[provider]);
    expect(next.operatorMessage).not.toMatch(/secure setup page|\/install/);
    expect(next.grokInstructions).toMatch(/secure secret-input/);
    expect(next.grokInstructions).toMatch(/Fallback only/);
    expect(next.grokInstructions).not.toMatch(new RegExp(SB_SECRET));
    return h;
  }

  it("offers Sendblue, then a Sendblue secure setup path", async () => {
    const h = await choose("sendblue");
    const link = await h.ok("get_secure_setup_url", { step: "visitor-messaging" });
    expect(link.url).toContain("step=visitor-messaging");
    expect(JSON.stringify(link)).not.toContain(SB_KEY);
  });

  it("offers Twilio, then Twilio fields and no secret echo", async () => {
    const h = await choose("twilio");
    const fake = fakeTwilio();
    const provider = new TwilioMessagingProvider({ env: () => readTwilioEnv({ ...h.inst.env(), TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID, TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER, PUBLIC_BASE_URL: PUBLIC }), client: fake });
    h.inst.secrets.set({ TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID, TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER });
    expect(provider.validateConfiguration().ok).toBe(true);
    const status = await h.status();
    expect(JSON.stringify(status)).not.toContain(TWILIO_TOKEN);
    expect(JSON.stringify(status)).not.toContain(TWILIO_SID);
  });

  it("offers Photon, then line discovery without leaking the project secret", async () => {
    const h = await choose("photon");
    const lines = fakePhoton({ lines: [
      { id: "a", phoneNumber: "+15555550123", status: "available" },
      { id: "b", phoneNumber: "+15555550124", status: "available" },
    ] });
    const provider = new PhotonMessagingProvider({
      env: () => photonEnv(),
      client: lines,
    });
    const result = await provider.connect({ saveSecret: (values) => h.inst.secrets.set(values as never) });
    expect(result.needsLineChoice).toBe(true);
    expect(result.lines?.map((l) => l.address)).toEqual(["+15555550123", "+15555550124"]);
    expect(JSON.stringify(result)).not.toContain(PHOTON_SECRET);
    const status = await h.status();
    expect(JSON.stringify(status)).not.toContain(PHOTON_SECRET);
  });

  it("asks which discovered Photon line to use and does not ask for a typed number", async () => {
    const h = await choose("photon");
    h.inst.secrets.set({ TOURCORE_PHOTON_PROJECT_ID: PHOTON_ID, TOURCORE_PHOTON_PROJECT_SECRET: PHOTON_SECRET });
    h.inst.files.writeState({
      ...h.inst.files.state(),
      messagingLines: [
        { id: "a", address: "+15555550123", status: "available" },
        { id: "b", address: "+15555550124", status: "available" },
      ],
    });
    const step = await h.ok("get_next_installation_step");
    expect(step).toMatchObject({ action: "CHOOSE_MESSAGING_LINE", performedBy: "OPERATOR_DECISION" });
    expect(step.operatorMessage).toBe("Photon is connected. Which of these lines should prospects text?");
    expect(step.operatorMessage).not.toMatch(/secure setup page|\/install/);
    expect(step.choices.map((c: { id: string }) => c.id)).toEqual(["+15555550123", "+15555550124"]);
    const picked = await h.ok("choose_messaging_line", { line: "+15555550123" });
    expect(picked.line).toBe("+15555550123");
    expect(JSON.stringify(picked)).not.toContain(PHOTON_SECRET);
    expect(h.inst.secrets.get("TOURCORE_PHOTON_PHONE_NUMBER")).toBe("+15555550123");
  });
});

describe("Twilio visitor pipeline", () => {
  it("handles STOP, START, HELP and keyword consent without a second booking, and an outage does not replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-twilio-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = new PropertyWorkspace(root);
    const { config } = ws.save(hillsideConfig());
    ws.recordReadiness(config.property.id, await runReadinessCheck(config));
    publishForVisitors(ws, config.property.id, new Date());
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    const env: NodeJS.ProcessEnv = { PUBLIC_BASE_URL: PUBLIC, TOURCORE_SMS_CONSENT_MODE: "keyword_confirm", TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID, TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER };
    const client = fakeTwilio();
    cleanups.push(setTwilioClient(() => client));
    const installation = new Installation({ root, runtime, env: () => env, now: () => Date.now() });
    installation.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
    installation.files.setPublicBaseUrl(PUBLIC, "MANUAL");
    installation.files.writeState({ ...installation.files.state(), messagingProviderChoice: "twilio" });
    installation.secrets.set({ TOURCORE_TWILIO_ACCOUNT_SID: TWILIO_SID, TOURCORE_TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TOURCORE_TWILIO_PHONE_NUMBER: TWILIO_NUMBER });
    const server = createSetupServer({
    toolSurface: "all", workspace: ws, installation, operatorToken: () => "test-operator-token-abcdef", log: () => {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const post = async (body: string, sid: string) => {
      const fields = { MessageSid: sid, From: VISITOR, To: TWILIO_NUMBER, Body: body, SmsStatus: "received" };
      const raw = new URLSearchParams(fields).toString();
      const signature = twilioSignature(TWILIO_TOKEN, `${PUBLIC}/webhooks/twilio`, fields);
      const before = client.sent.length;
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: raw });
      expect(res.status).toBe(200);
      return client.sent.slice(before).map((m) => m.body).join("\n");
    };

    const first = await post("Hi", "SM1");
    expect(first).toMatch(/TOUR|YES|STOP/);
    const dup = await post("Hi", "SM1");
    expect(dup).toBe("");
    expect(await post("HELP", "SM2")).toMatch(/STOP/);
    expect(await post("STOP", "SM3")).toMatch(/opted out/i);
    expect(await post("book a tour", "SM4")).toBe("");
    expect(await post("START", "SM5")).toMatch(/YES|STOP/);

    client.sent.length = 0;
    const boom = fakeTwilio({ down: true });
    setTwilioClient(() => boom);
    const fields = { MessageSid: "SM6", From: VISITOR, To: TWILIO_NUMBER, Body: "YES", SmsStatus: "received" };
    const signature = twilioSignature(TWILIO_TOKEN, `${PUBLIC}/webhooks/twilio`, fields);
    const failed = await fetch(`http://127.0.0.1:${port}/webhooks/twilio`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: new URLSearchParams(fields).toString() });
    expect(failed.status).toBe(200);
    const replay = await fetch(`http://127.0.0.1:${port}/webhooks/twilio`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: new URLSearchParams(fields).toString() });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
  });
});

describe("consent mode", () => {
  it("lets the deployment override each provider, and does not copy Twilio's recommendation onto Photon", () => {
    expect(resolveConsentMode({ TOURCORE_SMS_CONSENT_MODE: "keyword_confirm" }, "disabled")).toBe("keyword_confirm");
    expect(resolveConsentMode({ TOURCORE_SMS_CONSENT_MODE: "disabled" }, "keyword_confirm")).toBe("disabled");
    expect(providerConsentRecommendation("twilio")).toMatchObject({ mode: "keyword_confirm", source: "provider_recommendation" });
    expect(providerConsentRecommendation("sendblue")).toMatchObject({ mode: "keyword_confirm", source: "no_provider_requirement" });
    expect(providerConsentRecommendation("sendblue").note).toMatch(/not Twilio A2P/i);
    expect(providerConsentRecommendation("photon")).toMatchObject({ mode: "disabled", source: "no_provider_requirement" });
    expect(providerConsentRecommendation("photon").note).not.toMatch(/A2P/);
    expect(consentModeForProvider({}, "photon")).toBe("disabled");
    expect(consentModeForProvider({ TOURCORE_SMS_CONSENT_MODE: "keyword_confirm" }, "photon")).toBe("keyword_confirm");
    expect(consentModeForProvider({ TOURCORE_SMS_CONSENT_MODE: "disabled" }, "twilio")).toBe("disabled");
  });
});
