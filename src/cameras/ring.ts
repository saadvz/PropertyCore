import { createHmac, timingSafeEqual } from "node:crypto";
import { CameraProviderError, type AccountRef, type CameraEvent, type CameraProfile, type CameraProvider, type CameraWebhook, type ClipRef, type Tokens } from "./adapter";
import type { CameraKind } from "./lines";

/**
 * Ring's developer API (the Ring Appstore / Partner API) behind the camera adapter (#239). Field names follow
 * developer.amazon.com/docs/ring/ as read on 19 and 25 Nov 2026. Linking is Ring's one-way account linking (#302):
 * Ring posts a code to us, then sends the host's browser with a signed nonce. Starting from our side with PKCE is by
 * invitation only at Ring, and an app uses one method. No token, secret or response body is ever put in an error or a log.
 */

export interface RingOptions {
  clientId: string;
  clientSecret: string;
  /** The HMAC key Ring signs webhooks and account-link nonces with. */
  webhookKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  apiBase?: string;
  oauthBase?: string;
}

const API = "https://api.amazonvision.com";
const OAUTH = "https://oauth.ring.com";
/** Refresh a little before Ring's 4 hours run out. */
const EARLY_MS = 120_000;
const MAX_CLIP_MS = 900_000;
const MAX_HISTORY_PAGES = 20;

const KINDS: Record<string, CameraKind> = { motion_detected: "motion", button_press: "ding", device_online: "online", device_offline: "offline" };
const HISTORY_KINDS: Record<string, CameraKind> = { motion: "motion", ding: "ding" };

/**
 * Refreshes in flight, by the refresh token they spend. Ring retires a refresh token once it's used, so two calls
 * holding the same expired token share one refresh instead of the second being refused. Module-wide, since the service
 * builds a provider per call.
 */
const refreshing = new Map<string, Promise<Tokens>>();

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export function ringProvider(options: RingOptions): CameraProvider {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const api = options.apiBase ?? API;
  const oauth = options.oauthBase ?? OAUTH;

  async function tokenCall(form: Record<string, string>): Promise<Tokens> {
    let response: Response;
    try {
      response = await fetch(`${oauth}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, client_id: options.clientId, client_secret: options.clientSecret }).toString(),
      });
    } catch {
      throw new CameraProviderError("Ring couldn't be reached.", "failed");
    }
    if (response.status === 400 || response.status === 401) throw new CameraProviderError("Ring no longer accepts this sign-in. The host needs to connect Ring again.", "unlinked");
    if (!response.ok) throw new CameraProviderError(`Ring's sign-in answered ${response.status}.`, "failed");
    const body = obj(await response.json().catch(() => ({})));
    const access = str(body.access_token);
    const refresh = str(body.refresh_token);
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 14400;
    if (!access || !refresh) throw new CameraProviderError("Ring's sign-in gave no tokens.", "failed");
    return { access, refresh, expiresAt: now().getTime() + seconds * 1000 };
  }

  /** A working access token. A refresh is saved before the new token is used, since Ring retires the old refresh token. */
  async function access(account: AccountRef): Promise<string> {
    const tokens = account.tokens.get();
    if (!tokens) throw new CameraProviderError("Ring isn't connected for this property.", "unlinked");
    if (tokens.expiresAt - EARLY_MS > now().getTime()) return tokens.access;
    let pending = refreshing.get(tokens.refresh);
    if (!pending) {
      pending = tokenCall({ grant_type: "refresh_token", refresh_token: tokens.refresh }).then((next) => {
        account.tokens.save(next);
        return next;
      });
      const spent = tokens.refresh;
      refreshing.set(spent, pending);
      void pending.finally(() => refreshing.delete(spent)).catch(() => undefined);
    }
    return (await pending).access;
  }

  async function call(account: AccountRef, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    // The token goes only to Ring's API host: a next-page link from a response is followed only on that host.
    const url = new URL(path, api);
    if (url.origin !== new URL(api).origin) throw new CameraProviderError("Ring gave a link to another site, so it wasn't followed.", "failed");
    const token = await access(account);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.api+json, application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new CameraProviderError("Ring couldn't be reached.", "failed");
    }
    if (response.ok) return response;
    const code = await response
      .clone()
      .json()
      .then((body) => str(obj((obj(body).errors as unknown[] | undefined)?.[0]).code))
      .catch(() => undefined);
    if (code === "ring_base_plan_required") throw new CameraProviderError("This Ring account needs a Ring plan or trial before its cameras can be read.", "plan-required");
    if (response.status === 401) throw new CameraProviderError("Ring no longer accepts this sign-in. The host needs to connect Ring again.", "unlinked");
    if (response.status === 429) throw new CameraProviderError("Ring asked us to slow down.", "rate-limited");
    if (response.status === 503) throw new CameraProviderError("The camera is offline.", "offline");
    throw new CameraProviderError(`Ring answered ${response.status}.`, "failed");
  }

  const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  return {
    name: "ring",

    ownsClient(clientId) {
      const given = Buffer.from(clientId);
      const ours = Buffer.from(options.clientId);
      return given.length === ours.length && timingSafeEqual(given, ours);
    },

    exchangeCode: (code) => tokenCall({ grant_type: "authorization_code", code }),

    async profile(account): Promise<CameraProfile> {
      const data = obj(obj(await (await call(account, "/v1/users/me")).json()).data);
      const accountId = str(data.id);
      if (!accountId) throw new CameraProviderError("Ring didn't say whose account this is.", "failed");
      const email = str(obj(data.attributes).email);
      return { accountId, ...(email ? { email } : {}) };
    },

    // URL-safe base64 with no padding, over "<time in ms>:<account id>". Webhooks use the same key in hex.
    linkNonce: (time, accountId) => createHmac("sha256", options.webhookKey).update(`${time}:${accountId}`).digest("base64url"),

    async confirmLink(account, { nonce, accountIdentifier }) {
      // POST has Ring check the nonce and turn on the cameras the host shared; PATCH marks the link complete. Both are required.
      await call(account, "/v1/accounts/me/app-integrations", { method: "POST", body: { account_identifier: accountIdentifier, nonce } });
      await call(account, "/v1/accounts/me/app-integrations", { method: "PATCH", body: { status: "completed" } });
    },

    async devices(account) {
      const body = obj(await (await call(account, "/v1/devices")).json());
      const data = Array.isArray(body.data) ? body.data : [];
      return data.flatMap((item) => {
        const device = obj(item);
        const id = str(device.id);
        const name = str(obj(device.attributes).name);
        return id ? [{ id, name: name ?? "Camera" }] : [];
      });
    },

    parseWebhook(rawBody, headers): CameraWebhook | undefined {
      const header = headers["x-signature"];
      const given = typeof header === "string" ? header.replace(/^sha256=/, "") : undefined;
      if (!given || !/^[a-f0-9]{64}$/i.test(given)) return undefined;
      const want = createHmac("sha256", options.webhookKey).update(rawBody).digest();
      if (!timingSafeEqual(want, Buffer.from(given, "hex"))) return undefined;
      let payload: Json;
      try {
        payload = obj(JSON.parse(rawBody.toString("utf8")));
      } catch {
        return undefined;
      }
      const meta = obj(payload.meta);
      const data = obj(payload.data);
      const attributes = obj(data.attributes);
      const type = str(data.type);
      const accountId = str(meta.account_id);
      if (type === "app_integration_removed") return accountId ? { type: "unlinked", accountId } : { type: "ignored" };
      const kind = type ? KINDS[type] : undefined;
      if (!kind) return { type: "ignored" };
      const id = str(meta.request_id) ?? str(data.id);
      const deviceId = str(attributes.source);
      const at = typeof attributes.timestamp === "number" ? new Date(attributes.timestamp).toISOString() : str(meta.time);
      if (!id || !deviceId || !at || !Number.isFinite(Date.parse(at))) return undefined;
      const label = kind === "motion" ? str(attributes.sub_type) : undefined;
      const event: CameraEvent = { id, at: new Date(at).toISOString(), deviceId, kind, ...(label ? { label } : {}) };
      return { type: "event", ...(accountId ? { accountId } : {}), event };
    },

    async history(account, deviceId, since) {
      const after = Date.parse(since);
      const events: CameraEvent[] = [];
      let path: string | undefined = `/v1/history/devices/${encodeURIComponent(deviceId)}/events?event_types=motion,ding`;
      for (let page = 0; path && page < MAX_HISTORY_PAGES; page += 1) {
        const body = obj(await (await call(account, path)).json());
        let older = false;
        for (const item of Array.isArray(body.data) ? body.data : []) {
          const entry = obj(item);
          const attributes = obj(entry.attributes);
          const start = typeof attributes.start === "number" ? attributes.start : NaN;
          const kind = HISTORY_KINDS[str(attributes.event_type) ?? ""];
          const id = str(entry.id);
          if (!Number.isFinite(start) || start <= after) {
            older = true;
            continue;
          }
          if (kind && id) events.push({ id, at: new Date(start).toISOString(), deviceId, kind });
        }
        // Newest first: once a page reaches back past `since`, nothing older is needed.
        const next = str(obj(body.links).next);
        // A next page on any other host is not followed: the token goes only to Ring's API.
        path = older || !next || new URL(next, api).origin !== new URL(api).origin ? undefined : next;
      }
      return events;
    },

    async snapshot(account, deviceId, at) {
      const response = await call(account, `/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, { method: "POST", body: { type: "at_timestamp", timestamp: Date.parse(at), image_options: { format: "jpeg" } } });
      return bytes(response);
    },

    async clip(account, ref: ClipRef) {
      const from = Date.parse(ref.from);
      const duration = Math.min(Math.max(Date.parse(ref.until) - from, 1000), MAX_CLIP_MS);
      const response = await call(account, `/v1/devices/${encodeURIComponent(ref.deviceId)}/media/video/download`, { method: "POST", body: { timestamp: from, duration } });
      return bytes(response);
    },

    async status(account, deviceId) {
      try {
        const body = obj(await (await call(account, `/v1/devices/${encodeURIComponent(deviceId)}/status`)).json());
        return obj(obj(body.data).attributes).online === false ? "offline" : "online";
      } catch (error) {
        if (error instanceof CameraProviderError && error.reason === "offline") return "offline";
        throw error;
      }
    },
  };
}
