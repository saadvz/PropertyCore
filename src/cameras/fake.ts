import { createHmac, timingSafeEqual } from "node:crypto";
import { CameraProviderError, type AccountRef, type CameraDevice, type CameraEvent, type CameraProvider, type CameraWebhook, type ClipRef, type Tokens } from "./adapter";

/**
 * The in-memory camera provider every test uses (#239). It never touches the network. Webhooks are signed with a
 * made-up key the same way the real provider signs them, so the verify path is exercised.
 */

export interface FakeCameraProvider extends CameraProvider {
  cameras: CameraDevice[];
  events: CameraEvent[];
  offline: Set<string>;
  /** Every call, for assertions: name and device. Never tokens. */
  calls: { call: string; deviceId?: string }[];
  /** Sign a webhook body the way the provider would. */
  sign(body: string): string;
  /** A signed webhook delivery for an event. */
  webhook(event: CameraEvent | { unlinked: string }, accountId?: string): { body: Buffer; headers: Record<string, string> };
  failSnapshots: number;
}

export function fakeCameraProvider(options: { key?: string; now?: () => Date } = {}): FakeCameraProvider {
  const key = options.key ?? "fake-webhook-key";
  const now = options.now ?? (() => new Date());
  const sign = (body: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
  const need = (account: AccountRef) => {
    if (!account.tokens.get()) throw new CameraProviderError("The camera account isn't linked.", "unlinked");
  };
  const fake: FakeCameraProvider = {
    name: "fake",
    cameras: [],
    events: [],
    offline: new Set(),
    calls: [],
    failSnapshots: 0,
    sign,
    linkUrl: ({ state, codeChallenge, redirectUri }) => `https://fake-camera.example/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async finishLink({ code }): Promise<Tokens> {
      fake.calls.push({ call: "finishLink" });
      if (code !== "good-code") throw new CameraProviderError("The sign-in didn't finish.", "failed");
      return { access: "fake-access", refresh: "fake-refresh", expiresAt: now().getTime() + 4 * 3600_000 };
    },
    async devices(account) {
      need(account);
      fake.calls.push({ call: "devices" });
      return fake.cameras.map((camera) => ({ ...camera }));
    },
    parseWebhook(rawBody, headers): CameraWebhook | undefined {
      const given = headers["x-signature"];
      if (typeof given !== "string") return undefined;
      const want = Buffer.from(sign(rawBody.toString("utf8")));
      const got = Buffer.from(given);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
      try {
        const parsed = JSON.parse(rawBody.toString("utf8")) as { accountId?: string; event?: CameraEvent; unlinked?: string };
        if (parsed.unlinked) return { type: "unlinked", accountId: parsed.unlinked };
        if (parsed.event) return { type: "event", ...(parsed.accountId ? { accountId: parsed.accountId } : {}), event: parsed.event };
        return { type: "ignored" };
      } catch {
        return undefined;
      }
    },
    webhook(event, accountId) {
      const body = "unlinked" in event ? JSON.stringify({ unlinked: event.unlinked }) : JSON.stringify({ ...(accountId ? { accountId } : {}), event });
      return { body: Buffer.from(body), headers: { "x-signature": sign(body) } };
    },
    async history(account, deviceId, since) {
      need(account);
      fake.calls.push({ call: "history", deviceId });
      return fake.events.filter((event) => event.deviceId === deviceId && Date.parse(event.at) > Date.parse(since)).map((event) => ({ ...event }));
    },
    async snapshot(account, deviceId) {
      need(account);
      fake.calls.push({ call: "snapshot", deviceId });
      if (fake.failSnapshots > 0) {
        fake.failSnapshots -= 1;
        throw new CameraProviderError("The snapshot didn't come.", "failed");
      }
      if (fake.offline.has(deviceId)) throw new CameraProviderError("The camera is offline.", "offline");
      return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    },
    async clip(account, ref: ClipRef) {
      need(account);
      fake.calls.push({ call: "clip", deviceId: ref.deviceId });
      return new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    },
    async status(account, deviceId) {
      need(account);
      fake.calls.push({ call: "status", deviceId });
      return fake.offline.has(deviceId) ? "offline" : "online";
    },
  };
  return fake;
}
