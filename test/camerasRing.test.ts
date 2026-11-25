import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Tokens, TokenStore } from "../src/cameras/adapter";
import { ringProvider } from "../src/cameras/ring";

const KEY = "made-up-signing-key";
const sign = (body: string) => `sha256=${createHmac("sha256", KEY).update(body).digest("hex")}`;
const NOW = Date.parse("2026-11-20T12:00:00Z");

function store(initial?: Tokens): TokenStore & { saved: Tokens[] } {
  let current = initial;
  const saved: Tokens[] = [];
  return { saved, get: () => current, save: (tokens) => { current = tokens; saved.push(tokens); } };
}

type Call = { url: string; init?: RequestInit };
function stubFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), ...(init ? { init } : {}) };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const make = (fetch: typeof globalThis.fetch) => ringProvider({ clientId: "client-x", clientSecret: "secret-y", webhookKey: KEY, fetch, now: () => new Date(NOW) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const motion = {
  meta: { version: "1.0", time: "2026-11-20T03:14:00.000Z", request_id: "req-111", account_id: "acct-1" },
  data: { id: "dev-aaa_motion_1795144440000", type: "motion_detected", attributes: { source: "dev-aaa", source_type: "devices", timestamp: 1795144440000, timestamp_readable: "Nov 20 3:14 AM", sub_type: "human" } },
};

describe("Ring webhooks", () => {
  it("reads a signed motion event", () => {
    const body = JSON.stringify(motion);
    const parsed = make(stubFetch(() => json({})).fetch).parseWebhook(Buffer.from(body), { "x-signature": sign(body) });
    expect(parsed).toEqual({ type: "event", accountId: "acct-1", event: { id: "req-111", at: "2026-11-20T03:14:00.000Z", deviceId: "dev-aaa", kind: "motion", label: "human" } });
  });

  it("refuses a missing or wrong signature, and a body changed after signing", () => {
    const body = JSON.stringify(motion);
    const ring = make(stubFetch(() => json({})).fetch);
    expect(ring.parseWebhook(Buffer.from(body), {})).toBeUndefined();
    expect(ring.parseWebhook(Buffer.from(body), { "x-signature": "sha256=00" })).toBeUndefined();
    expect(ring.parseWebhook(Buffer.from(body.replace("human", "vehicle")), { "x-signature": sign(body) })).toBeUndefined();
  });

  it("maps a doorbell press, online and offline, and the app being removed", () => {
    const ring = make(stubFetch(() => json({})).fetch);
    const read = (payload: unknown) => {
      const body = JSON.stringify(payload);
      return ring.parseWebhook(Buffer.from(body), { "x-signature": sign(body) });
    };
    const base = (type: string) => ({ meta: { ...motion.meta, request_id: `req-${type}` }, data: { id: `dev-aaa_${type}_1`, type, attributes: { source: "dev-aaa", source_type: "devices", timestamp: 1795144440000 } } });
    expect(read(base("button_press"))).toMatchObject({ type: "event", event: { kind: "ding", deviceId: "dev-aaa" } });
    expect(read(base("device_offline"))).toMatchObject({ type: "event", event: { kind: "offline" } });
    expect(read(base("device_online"))).toMatchObject({ type: "event", event: { kind: "online" } });
    expect(read({ meta: motion.meta, data: { id: "x", type: "app_integration_removed", attributes: { source: "acct-1", source_type: "users", timestamp: 1 } } })).toEqual({ type: "unlinked", accountId: "acct-1" });
    expect(read({ meta: motion.meta, data: { id: "x", type: "subscription_activated", attributes: {} } })).toEqual({ type: "ignored" });
  });

  it("keeps plain motion as its label when smart alerts are off", () => {
    const payload = { ...motion, data: { ...motion.data, attributes: { ...motion.data.attributes, sub_type: "motion" } } };
    const body = JSON.stringify(payload);
    expect(make(stubFetch(() => json({})).fetch).parseWebhook(Buffer.from(body), { "x-signature": sign(body) })).toMatchObject({ event: { label: "motion" } });
  });
});

describe("Ring tokens", () => {
  it("trades the code Ring posted for tokens with the client's own secret", async () => {
    const { calls, fetch } = stubFetch(() => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 14400, token_type: "Bearer", scope: "ava.v1:read" }));
    const tokens = await make(fetch).exchangeCode("c-1");
    expect(tokens).toEqual({ access: "at-1", refresh: "rt-1", expiresAt: NOW + 14400 * 1000 });
    expect(calls[0]!.url).toBe("https://oauth.ring.com/oauth/token");
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", code: "c-1", client_id: "client-x", client_secret: "secret-y" });
  });

  it("knows its own client id and no other", () => {
    const ring = make(stubFetch(() => json({})).fetch);
    expect(ring.ownsClient("client-x")).toBe(true);
    expect(ring.ownsClient("client-y")).toBe(false);
    expect(ring.ownsClient("")).toBe(false);
  });

  it("refreshes an expired access token and saves the new refresh token before using it", async () => {
    const tokens = store({ access: "old", refresh: "rt-old", expiresAt: NOW - 1 });
    const { calls, fetch } = stubFetch((call) => {
      if (call.url.includes("oauth")) return json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 14400 });
      expect(tokens.saved.at(-1)?.refresh).toBe("rt-new");
      return json({ data: [{ type: "devices", id: "dev-aaa", attributes: { name: "Front door" } }] });
    });
    const devices = await make(fetch).devices({ tokens });
    expect(devices).toEqual([{ id: "dev-aaa", name: "Front door" }]);
    expect(new URLSearchParams(String(calls[0]!.init!.body)).get("refresh_token")).toBe("rt-old");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer at-new");
  });

  it("says plainly when the account needs a Ring plan, without the body", async () => {
    const tokens = store({ access: "at", refresh: "rt", expiresAt: NOW + 3600_000 });
    const { fetch } = stubFetch(() => json({ errors: [{ code: "ring_base_plan_required", detail: "token at" }] }, 403));
    await expect(make(fetch).devices({ tokens })).rejects.toMatchObject({ reason: "plan-required" });
    await expect(make(fetch).devices({ tokens })).rejects.not.toThrow(/token at/);
  });

  it("says the account is unlinked when the refresh is refused", async () => {
    const tokens = store({ access: "old", refresh: "rt-old", expiresAt: NOW - 1 });
    const { fetch } = stubFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(make(fetch).devices({ tokens })).rejects.toMatchObject({ reason: "unlinked" });
  });
});

describe("Ring media and status", () => {
  const tokens = () => store({ access: "at", refresh: "rt", expiresAt: NOW + 3600_000 });

  it("asks for a snapshot at the event's time in epoch ms", async () => {
    const { calls, fetch } = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const image = await make(fetch).snapshot({ tokens: tokens() }, "dev-aaa", "2026-11-20T03:14:00.000Z");
    expect([...image]).toEqual([1, 2, 3]);
    expect(calls[0]!.url).toBe("https://api.amazonvision.com/v1/devices/dev-aaa/media/image/download");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ type: "at_timestamp", timestamp: Date.parse("2026-11-20T03:14:00.000Z") });
  });

  it("asks for a clip from its start for its length, capped at 15 minutes", async () => {
    const { calls, fetch } = stubFetch(() => new Response(new Uint8Array([9]), { status: 200 }));
    await make(fetch).clip({ tokens: tokens() }, { deviceId: "dev-aaa", from: "2026-11-20T03:13:30.000Z", until: "2026-11-20T03:15:00.000Z" });
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ timestamp: Date.parse("2026-11-20T03:13:30.000Z"), duration: 90_000 });
    await make(fetch).clip({ tokens: tokens() }, { deviceId: "dev-aaa", from: "2026-11-20T03:00:00.000Z", until: "2026-11-20T04:00:00.000Z" });
    expect(JSON.parse(String(calls[1]!.init!.body)).duration).toBe(900_000);
  });

  it("reads every camera's online state from the device list with include=status (#302), as Ring's docs show it", async () => {
    const { calls, fetch } = stubFetch(() =>
      json({
        meta: { time: "2026-11-25T19:00:00Z" },
        data: [
          { type: "devices", id: "dev-aaa", attributes: { name: "Front door" }, relationships: { status: { data: { type: "device-status", id: "dev-aaa.status" }, links: { related: "/v1/devices/dev-aaa/status" } } } },
          { type: "devices", id: "dev-bbb", attributes: { name: "Driveway" }, relationships: { status: { data: { type: "device-status", id: "dev-bbb.status" } } } },
          { type: "devices", id: "dev-ccc", attributes: { name: "Side gate" } },
        ],
        included: [
          { type: "device-status", id: "dev-aaa.status", attributes: { online: true } },
          { type: "device-status", id: "dev-bbb.status", attributes: { online: false } },
          { type: "device-capabilities", id: "dev-aaa.capabilities", attributes: { online: false } },
        ],
      }),
    );
    expect(await make(fetch).devices({ tokens: tokens() })).toEqual([
      { id: "dev-aaa", name: "Front door", online: true },
      { id: "dev-bbb", name: "Driveway", online: false },
      { id: "dev-ccc", name: "Side gate" },
    ]);
    expect(calls[0]!.url).toBe("https://api.amazonvision.com/v1/devices?include=status");
  });

  it("doesn't take a status answer without the online field as online", async () => {
    const empty = stubFetch(() => json({ data: { type: "device-status", id: "dev-aaa", attributes: {} } }));
    await expect(make(empty.fetch).status({ tokens: tokens() }, "dev-aaa")).rejects.toMatchObject({ reason: "failed" });
    const offline = stubFetch(() => json({ data: { type: "device-status", id: "dev-aaa", attributes: { online: false } } }));
    expect(await make(offline.fetch).status({ tokens: tokens() }, "dev-aaa")).toBe("offline");
  });

  it("reads status, and a 503 as offline", async () => {
    const online = stubFetch(() => json({ data: { type: "device-status", id: "dev-aaa", attributes: { online: true } } }));
    expect(await make(online.fetch).status({ tokens: tokens() }, "dev-aaa")).toBe("online");
    const down = stubFetch(() => json({}, 503));
    expect(await make(down.fetch).status({ tokens: tokens() }, "dev-aaa")).toBe("offline");
  });

  it("reads history newer than a time, following pages, with no labels", async () => {
    const page1 = { data: [{ type: "history-events", id: "h-3", attributes: { event_type: "motion", start: Date.parse("2026-11-20T03:30:00Z"), end: 0 }, relationships: { source: { data: { type: "devices", id: "dev-aaa" } } } }], links: { next: "/v1/history/devices/dev-aaa/events?page[key]=p2" } };
    const page2 = { data: [{ type: "history-events", id: "h-2", attributes: { event_type: "ding", start: Date.parse("2026-11-20T03:20:00Z"), end: 0 } }, { type: "history-events", id: "h-1", attributes: { event_type: "motion", start: Date.parse("2026-11-20T02:00:00Z"), end: 0 } }], links: {} };
    const { calls, fetch } = stubFetch((call) => json(call.url.includes("p2") ? page2 : page1));
    const events = await make(fetch).history({ tokens: tokens() }, "dev-aaa", "2026-11-20T03:00:00Z");
    expect(events).toEqual([
      { id: "h-3", at: "2026-11-20T03:30:00.000Z", deviceId: "dev-aaa", kind: "motion" },
      { id: "h-2", at: "2026-11-20T03:20:00.000Z", deviceId: "dev-aaa", kind: "ding" },
    ]);
    expect(calls[1]!.url).toBe("https://api.amazonvision.com/v1/history/devices/dev-aaa/events?page[key]=p2");
  });

});

describe("Ring's one-way account linking (#302)", () => {
  const live: Tokens = { access: "at-1", refresh: "rt-1", expiresAt: NOW + 3600_000 };

  it("reads whose account the tokens are over the token", async () => {
    const { calls, fetch } = stubFetch(() => json({ data: { type: "users", id: "ava1.ring.account.XXXYYY", attributes: { first_name: "Jane", email: "jane@example.com" } } }));
    expect(await make(fetch).profile({ tokens: store(live) })).toEqual({ accountId: "ava1.ring.account.XXXYYY", email: "jane@example.com" });
    expect(calls[0]!.url).toBe("https://api.amazonvision.com/v1/users/me");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer at-1");
    await expect(make(stubFetch(() => json({ data: {} })).fetch).profile({ tokens: store(live) })).rejects.toMatchObject({ reason: "failed" });
  });

  it("signs the nonce as Ring does: URL-safe base64 with no padding over time:account", () => {
    const ring = make(stubFetch(() => json({})).fetch);
    const nonce = ring.linkNonce("1771130906289", "ava1.ring.account.XXXYYY");
    expect(nonce).toBe(createHmac("sha256", KEY).update("1771130906289:ava1.ring.account.XXXYYY").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ring.linkNonce("1771130906289", "ava1.ring.account.OTHER")).not.toBe(nonce);
  });

  it("sends the nonce back to Ring, then marks the link completed", async () => {
    const { calls, fetch } = stubFetch(() => json({ data: { type: "app-integrations", attributes: { status: "awaiting" } } }));
    await make(fetch).confirmLink({ tokens: store(live) }, { nonce: "n-1", accountIdentifier: "L***e" });
    expect(calls.map((call) => [call.init!.method, call.url])).toEqual([
      ["POST", "https://api.amazonvision.com/v1/accounts/me/app-integrations"],
      ["PATCH", "https://api.amazonvision.com/v1/accounts/me/app-integrations"],
    ]);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ account_identifier: "L***e", nonce: "n-1" });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ status: "completed" });
  });

  it("stops at a refused nonce, with nothing of Ring's answer in the error", async () => {
    const { calls, fetch } = stubFetch(() => json({ errors: [{ title: "Invalid Nonce", detail: "n-1 at-1" }] }, 400));
    const error = await make(fetch).confirmLink({ tokens: store(live) }, { nonce: "n-1", accountIdentifier: "L***e" }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(calls).toHaveLength(1);
    expect(error?.message).toBe("Ring answered 400.");
  });
});

describe("Ring token refresh under load", () => {
  it("two calls with an expired token share one refresh", async () => {
    const tokens = store({ access: "old", refresh: "rt-shared", expiresAt: NOW - 1 });
    let refreshes = 0;
    const { fetch } = stubFetch((call) => {
      if (call.url.includes("oauth")) {
        refreshes += 1;
        return refreshes === 1 ? json({ access_token: "at-new", refresh_token: "rt-next", expires_in: 14400 }) : json({ error: "invalid_grant" }, 400);
      }
      return json({ data: [] });
    });
    const ring = make(fetch);
    await Promise.all([ring.devices({ tokens }), ring.devices({ tokens })]);
    expect(refreshes).toBe(1);
  });

  it("never sends the token to a host other than Ring's API, even when a next-page link points elsewhere", async () => {
    const tokens = store({ access: "at", refresh: "rt", expiresAt: NOW + 3600_000 });
    const { calls, fetch } = stubFetch(() => json({ data: [{ type: "history-events", id: "h", attributes: { event_type: "motion", start: NOW, end: 0 } }], links: { next: "https://evil.example/steal" } }));
    await make(fetch).history({ tokens }, "dev-aaa", "2026-11-19T00:00:00Z");
    expect(calls.every((call) => call.url.startsWith("https://api.amazonvision.com/"))).toBe(true);
  });
});
