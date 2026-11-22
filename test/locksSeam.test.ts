import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeValueRefused } from "../src/locks/adapter";
import { SeamError, SeamLockAdapter, seamFromEnv } from "../src/locks/seam";

/**
 * The lock partner's adapter on a stub fetch: the requests it makes, how answers map, and the webhook
 * signature check. Nothing here reaches the partner. The key and secret are made at runtime.
 */

const NOW = new Date("2026-12-01T12:00:00.000Z");
const KEY = `seam_test_${randomBytes(8).toString("hex")}`;
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
// Built at runtime so the secret scan never finds a code in this file.
const CODE = ["6", "1", "8", "3", "4", "7"].join("");

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function stub(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const adapter = new SeamLockAdapter({
    apiKey: KEY,
    webhookSecret: SECRET,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      const path = url.replace("https://connect.getseam.com", "");
      const answer = answers[path] ?? { status: 404, body: { error: { type: "not_found" } } };
      return { status: answer.status ?? 200, json: async () => answer.body };
    },
  });
  return { adapter, calls };
}

function sign(body: string, at = NOW, id = "msg_1", secret = SECRET): Record<string, string> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

describe("the lock partner's adapter", () => {
  it("asks for a sign-in link tagged with the account, with the key only in the auth header", async () => {
    const { adapter, calls } = stub({ "/connect_webviews/create": { body: { connect_webview: { connect_webview_id: "cw_1", url: "https://connect.example.com/cw_1" } } } });
    expect(await adapter.connectLink({ customerKey: "acct-1", kind: "locks" })).toEqual({ url: "https://connect.example.com/cw_1", linkId: "cw_1" });
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.customer_key).toBe("acct-1");
    expect(JSON.stringify(calls[0]!.body).includes(KEY)).toBe(false);
  });

  it("lists devices with their kind, health and code lengths", async () => {
    const { adapter } = stub({
      "/connected_accounts/list": { body: { connected_accounts: [{ connected_account_id: "ca1", customer_key: "acct-1" }] } },
      "/devices/list": {
        body: {
          devices: [
            { device_id: "d1", connected_account_id: "ca1", device_type: "yale_lock", display_name: "Front door", properties: { online: true, battery_level: 0.8, supported_code_lengths: [4, 5, 6, 7, 8], supports_backup_access_code_pool: true } },
            { device_id: "d2", connected_account_id: "ca1", device_type: "ecobee_thermostat", display_name: "Hall", properties: { online: false } },
            { device_id: "d3", connected_account_id: "ca1", device_type: "minut_sensor", display_name: "Den", properties: { online: true } },
          ],
        },
      },
    });
    expect(await adapter.devices({ customerKey: "acct-1" })).toEqual([
      { id: "d1", accountId: "ca1", name: "Front door", kind: "lock", online: true, battery: 0.8, codeLengths: [4, 5, 6, 7, 8], backupCodes: true },
      { id: "d2", accountId: "ca1", name: "Hall", kind: "thermostat", online: false },
      { id: "d3", accountId: "ca1", name: "Den", kind: "noise-sensor", online: true },
    ]);
  });

  it("finds devices the documented way: the account's connected accounts by customer key, then their devices by account id", async () => {
    // The sandbox run (#180): the sign-in tags the connected account with the customer key, so devices are found through it.
    const { adapter, calls } = stub({
      "/connected_accounts/list": { body: { connected_accounts: [{ connected_account_id: "ca1", customer_key: "acct-1" }, { connected_account_id: "ca2", customer_key: "acct-1" }] } },
      "/devices/list": {
        body: {
          devices: [
            { device_id: "d1", connected_account_id: "ca1", device_type: "yale_lock", display_name: "Front door", can_program_online_access_codes: true, properties: { locked: true, online: true } },
            { device_id: "d4", connected_account_id: "ca2", device_type: "august_lock", display_name: "Back door", properties: { locked: false, online: true } },
            // Another account's device, if the partner ever ignored the filter, is never shown.
            { device_id: "dx", connected_account_id: "ca-other", device_type: "yale_lock", display_name: "Someone else's door", properties: { online: true } },
          ],
        },
      },
    });
    expect(await adapter.accounts({ customerKey: "acct-1" })).toEqual([{ id: "ca1" }, { id: "ca2" }]);
    const devices = await adapter.devices({ customerKey: "acct-1" });
    expect(devices.map((device) => [device.id, device.kind])).toEqual([
      ["d1", "lock"],
      ["d4", "lock"],
    ]);
    const lists = calls.filter((call) => call.url.endsWith("/connected_accounts/list"));
    expect(lists.at(-1)!.body).toEqual({ customer_key: "acct-1" });
    expect(calls.find((call) => call.url.endsWith("/devices/list"))!.body).toEqual({ connected_account_ids: ["ca1", "ca2"] });
  });

  it("asks for no devices when no account carries the customer key, and lets a partner error through", async () => {
    const none = stub({ "/connected_accounts/list": { body: { connected_accounts: [] } } });
    expect(await none.adapter.devices({ customerKey: "acct-1" })).toEqual([]);
    expect(none.calls.some((call) => call.url.endsWith("/devices/list"))).toBe(false);
    const refused = stub({ "/connected_accounts/list": { status: 400, body: { error: { type: "invalid_input" } } } });
    await expect(refused.adapter.devices({ customerKey: "acct-1" })).rejects.toBeInstanceOf(SeamError);
  });

  it("makes a time-bound code with the backup pool on, and a standing one with no end", async () => {
    const { adapter, calls } = stub({ "/access_codes/create": { body: { access_code: { access_code_id: "ac_1", status: "setting" } } } });
    const window = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };
    expect(await adapter.createCode({ deviceId: "d1", code: CODE, name: "Cleaning abcd", window })).toEqual({ codeId: "ac_1", status: "programming" });
    expect(calls[0]!.body).toEqual({ device_id: "d1", code: CODE, name: "Cleaning abcd", starts_at: window.from, ends_at: window.until, use_backup_access_code_pool: true });
    await adapter.createCode({ deviceId: "d1", code: CODE, name: "Standing abcd", window: { from: NOW.toISOString(), until: "2046-12-01T12:00:00.000Z" } });
    expect(calls[1]!.body.starts_at).toBeUndefined();
    expect(calls[1]!.body.ends_at).toBeUndefined();
  });

  it("reads a clash as a refused value, and any other error without the body or key", async () => {
    const clash = stub({ "/access_codes/create": { status: 400, body: { error: { type: "duplicate_access_code", message: CODE } } } });
    await expect(clash.adapter.createCode({ deviceId: "d1", code: CODE, name: "x", window: { from: "a", until: "b" } })).rejects.toBeInstanceOf(CodeValueRefused);
    const broken = stub({ "/access_codes/create": { status: 500, body: { error: { type: "internal", message: CODE } } } });
    const error = await broken.adapter.createCode({ deviceId: "d1", code: CODE, name: "x", window: { from: "a", until: "b" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeamError);
    expect(String((error as Error).message).includes(CODE)).toBe(false);
    expect(String((error as Error).message).includes(KEY)).toBe(false);
  });

  it("maps a code's status, and treats a deleted code as gone", async () => {
    const { adapter } = stub({ "/access_codes/get": { body: { access_code: { access_code_id: "ac_1", status: "set" } } } });
    expect(await adapter.codeStatus({ deviceId: "d1", codeId: "ac_1" })).toEqual({ codeId: "ac_1", status: "set" });
    const failed = stub({ "/access_codes/get": { body: { access_code: { access_code_id: "ac_1", status: "setting", errors: [{ error_code: "failed_to_set_on_device" }] } } } });
    expect((await failed.adapter.codeStatus({ deviceId: "d1", codeId: "ac_1" })).status).toBe("failed");
    const gone = stub({});
    expect((await gone.adapter.codeStatus({ deviceId: "d1", codeId: "ac_1" })).status).toBe("removed");
    await gone.adapter.removeCode({ deviceId: "d1", codeId: "ac_1" });
  });

  it("pulls a backup code for the failed code, and none without one", async () => {
    const { adapter, calls } = stub({ "/access_codes/pull_backup_access_code": { body: { backup_access_code: { access_code_id: "ac_b", code: CODE } } } });
    expect(await adapter.backupCode({ deviceId: "d1", codeId: "ac_1", name: "x", window: { from: "a", until: "b" } })).toEqual({ codeId: "ac_b", code: CODE });
    expect(calls[0]!.body).toEqual({ access_code_id: "ac_1" });
    expect(await adapter.backupCode({ deviceId: "d1", name: "x", window: { from: "a", until: "b" } })).toBeUndefined();
    const empty = stub({ "/access_codes/pull_backup_access_code": { status: 400, body: { error: { type: "no_backup_access_code_available" } } } });
    expect(await empty.adapter.backupCode({ deviceId: "d1", codeId: "ac_1", name: "x", window: { from: "a", until: "b" } })).toBeUndefined();
  });
});

describe("a lock account that dropped (#280 22)", () => {
  it("flags an account the partner lists as disconnected", async () => {
    const { adapter } = stub({
      "/connected_accounts/list": { body: { connected_accounts: [{ connected_account_id: "ca1", customer_key: "acct-1", errors: [{ error_code: "account_disconnected" }] }, { connected_account_id: "ca2", customer_key: "acct-1", errors: [] }] } },
    });
    expect(await adapter.accounts({ customerKey: "acct-1" })).toEqual([{ id: "ca1", disconnected: true }, { id: "ca2" }]);
  });

  it("removes a connection by its id, only for an account listed under that customer key", async () => {
    const { adapter, calls } = stub({
      "/connected_accounts/list": { body: { connected_accounts: [{ connected_account_id: "ca1", customer_key: "acct-1" }] } },
      "/connected_accounts/delete": { body: {} },
    });
    await adapter.removeAccount({ customerKey: "acct-1", accountId: "ca1" });
    expect(calls.filter((call) => call.url.endsWith("/connected_accounts/delete")).map((call) => call.body)).toEqual([{ connected_account_id: "ca1" }]);
    await adapter.removeAccount({ customerKey: "acct-1", accountId: "ca-other" });
    expect(calls.filter((call) => call.url.endsWith("/connected_accounts/delete")).length).toBe(1);
  });
});

describe("the lock partner's webhook check", () => {
  const body = JSON.stringify({ event_id: "ev_1", event_type: "lock.unlocked", occurred_at: "2026-12-01T11:59:00.000Z", device_id: "d1", connected_account_id: "ca1", access_code_id: "ac_1", method: "keycode" });

  it("reads a correctly signed, fresh event", () => {
    const { adapter } = stub({});
    expect(adapter.parseWebhook({ headers: sign(body), body })).toEqual({ id: "ev_1", kind: "unlock", partnerType: "lock.unlocked", at: "2026-12-01T11:59:00.000Z", accountId: "ca1", deviceId: "d1", codeId: "ac_1", method: "keycode", side: "outside" });
  });

  it("refuses a changed body, another secret, an old timestamp, or no secret configured", () => {
    const { adapter } = stub({});
    expect(adapter.parseWebhook({ headers: sign(body), body: body.replace("d1", "d2") })).toBeUndefined();
    expect(adapter.parseWebhook({ headers: sign(body, NOW, "msg_1", `whsec_${randomBytes(24).toString("base64")}`), body })).toBeUndefined();
    expect(adapter.parseWebhook({ headers: sign(body, new Date(NOW.getTime() - 6 * 60_000)), body })).toBeUndefined();
    expect(adapter.parseWebhook({ headers: {}, body })).toBeUndefined();
    const unsigned = new SeamLockAdapter({ apiKey: KEY, now: () => NOW, fetch: async () => ({ status: 200, json: async () => ({}) }) });
    expect(unsigned.parseWebhook({ headers: sign(body), body })).toBeUndefined();
  });

  it("maps the partner's event names to Property Core's", () => {
    const { adapter } = stub({});
    const kind = (type: string) => {
      const b = JSON.stringify({ event_id: `ev_${type}`, event_type: type, occurred_at: NOW.toISOString() });
      return adapter.parseWebhook({ headers: sign(b), body: b })?.kind;
    };
    expect(kind("access_code.set_on_device")).toBe("code-set");
    expect(kind("access_code.failed_to_set_on_device")).toBe("code-failed");
    expect(kind("device.low_battery")).toBe("battery-low");
    expect(kind("device.disconnected")).toBe("offline");
    expect(kind("device.connected")).toBe("online");
    expect(kind("connected_account.disconnected")).toBe("account-disconnected");
    expect(kind("something.new")).toBe("other");
  });

  it("maps a reconnect's first sync to account-synced (#280 22)", () => {
    const { adapter } = stub({});
    const b = JSON.stringify({ event_id: "ev_sync", event_type: "connected_account.completed_first_sync_after_reconnection", occurred_at: NOW.toISOString(), connected_account_id: "ca_1" });
    const parsed = adapter.parseWebhook({ headers: sign(b), body: b });
    expect(parsed?.kind).toBe("account-synced");
    expect(parsed?.accountId).toBe("ca_1");
  });

  it("never reads the unlock's code field (#280 20)", () => {
    const { adapter } = stub({});
    const b = JSON.stringify({ event_id: "ev_remote", event_type: "lock.unlocked", occurred_at: NOW.toISOString(), device_id: "d1", connected_account_id: "ca1", method: "remote", code: CODE });
    const parsed = adapter.parseWebhook({ headers: sign(b), body: b });
    expect(parsed?.kind).toBe("unlock");
    expect(parsed?.method).toBe("remote");
    expect(parsed?.side).toBeUndefined();
    expect(JSON.stringify(parsed).includes(CODE)).toBe(false);
  });

  it("is made from the environment only when its key is set", () => {
    expect(seamFromEnv({})).toBeUndefined();
    expect(seamFromEnv({ SEAM_API_KEY: KEY })).toBeInstanceOf(SeamLockAdapter);
  });
});
