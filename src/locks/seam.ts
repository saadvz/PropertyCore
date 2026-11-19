import { createHmac, timingSafeEqual } from "node:crypto";
import { CodeValueRefused, type CodeOnDevice, type CodeStatus, type CodeWindow, type DeviceKind, type LockAdapter, type LockDevice, type LockEventKind, type LockWebhookEvent } from "./adapter";

/**
 * The lock partner's implementation of the lock adapter (#180): Seam's HTTP API, using access codes.
 * It's the only file that talks to Seam. The API key and webhook secret come from the service's
 * environment (SEAM_API_KEY, SEAM_WEBHOOK_SECRET); neither is ever logged, returned or put in an
 * error. A code value is sent to Seam only in createCode, and read back only from a backup code.
 * Tests pass a stub `fetch`; nothing in the test suite reaches Seam.
 *
 * To confirm in the sandbox run (spec, "Left to the builder"): the event names mapped below, the
 * customer_key filter on devices/list, and whether Access Grants give the same codes, events and
 * backup codes on a Yale lock. Until then, access codes.
 */

export const SEAM_API = "https://connect.getseam.com";
/** A signed webhook older than this is refused, so a captured one can't be replayed later. */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** A window this long or longer is a standing code: made with no start or end on the lock. */
const ONGOING_MS = 5 * 365 * 24 * 3600_000;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface SeamOptions {
  apiKey: string;
  webhookSecret?: string;
  fetch?: Fetch;
  now?: () => Date;
  base?: string;
}

/** A Seam error, without the request or the response body. */
export class SeamError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
  ) {
    super(`The lock partner answered ${status}${type ? ` (${type})` : ""}.`);
  }
}

interface SeamAccessCode {
  access_code_id: string;
  status?: string;
  code?: string;
  errors?: { error_code?: string }[];
}

interface SeamDevice {
  device_id: string;
  connected_account_id?: string;
  device_type?: string;
  display_name?: string;
  can_program_online_access_codes?: boolean;
  properties?: { online?: boolean; battery_level?: number; name?: string; supported_code_lengths?: number[]; supports_backup_access_code_pool?: boolean; locked?: boolean };
}

const EVENT_KINDS: Record<string, LockEventKind> = {
  "access_code.set_on_device": "code-set",
  "access_code.failed_to_set_on_device": "code-failed",
  "access_code.removed_from_device": "code-removed",
  "lock.unlocked": "unlock",
  "lock.locked": "lock",
  "device.low_battery": "battery-low",
  "device.disconnected": "offline",
  "device.connected": "online",
  "connected_account.connected": "account-connected",
  "connected_account.disconnected": "account-disconnected",
};

function kindOf(eventType: string): LockEventKind {
  const known = EVENT_KINDS[eventType];
  if (known) return known;
  if (/backup/.test(eventType) && /(low|exhaust|empty)/.test(eventType)) return "backup-low";
  return "other";
}

function deviceKind(device: SeamDevice): DeviceKind {
  const type = device.device_type ?? "";
  if (/thermostat/.test(type)) return "thermostat";
  if (/noise|minut|noiseaware/.test(type)) return "noise-sensor";
  if (/lock/.test(type) || device.properties?.locked !== undefined || device.can_program_online_access_codes) return "lock";
  return "other";
}

function codeStatusOf(code: SeamAccessCode): CodeStatus {
  if ((code.errors ?? []).some((error) => /fail|error/.test(error.error_code ?? ""))) return "failed";
  if (code.status === "set") return "set";
  if (code.status === "removing" || code.status === "unset") return "removed";
  return "programming";
}

export class SeamLockAdapter implements LockAdapter {
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;
  private readonly base: string;

  constructor(private readonly options: SeamOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
    this.base = options.base ?? SEAM_API;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", "Seam-Sdk-Name": "property-core" },
      body: JSON.stringify(body),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const type = (parsed as { error?: { type?: string } } | undefined)?.error?.type;
      throw new SeamError(res.status, typeof type === "string" ? type.slice(0, 80) : undefined);
    }
    return parsed as T;
  }

  async connectLink(input: { customerKey: string; kind: "locks" | "sensors" }): Promise<{ url: string; linkId: string }> {
    const reply = await this.call<{ connect_webview: { connect_webview_id: string; url: string } }>("/connect_webviews/create", {
      customer_key: input.customerKey,
      custom_metadata: { property_core_kind: input.kind },
    });
    return { url: reply.connect_webview.url, linkId: reply.connect_webview.connect_webview_id };
  }

  async devices(input: { customerKey: string }): Promise<LockDevice[]> {
    const reply = await this.call<{ devices: SeamDevice[] }>("/devices/list", { customer_key: input.customerKey });
    return (reply.devices ?? []).map((device) => ({
      id: device.device_id,
      accountId: device.connected_account_id ?? "",
      name: (device.display_name ?? device.properties?.name ?? "A lock").slice(0, 60),
      kind: deviceKind(device),
      online: device.properties?.online !== false,
      ...(typeof device.properties?.battery_level === "number" ? { battery: device.properties.battery_level } : {}),
      ...(Array.isArray(device.properties?.supported_code_lengths) ? { codeLengths: device.properties.supported_code_lengths } : {}),
      ...(typeof device.properties?.supports_backup_access_code_pool === "boolean" ? { backupCodes: device.properties.supports_backup_access_code_pool } : {}),
    }));
  }

  private timing(window: CodeWindow): Record<string, string> {
    const ongoing = Date.parse(window.until) - this.now().getTime() >= ONGOING_MS;
    return ongoing ? {} : { starts_at: window.from, ends_at: window.until };
  }

  async createCode(input: { deviceId: string; code: string; name: string; window: CodeWindow }): Promise<CodeOnDevice> {
    try {
      const reply = await this.call<{ access_code: SeamAccessCode }>("/access_codes/create", {
        device_id: input.deviceId,
        code: input.code,
        name: input.name,
        ...this.timing(input.window),
        use_backup_access_code_pool: true,
      });
      return { codeId: reply.access_code.access_code_id, status: codeStatusOf(reply.access_code) };
    } catch (error) {
      // A code value the lock already holds is a clash, not a failure: the caller tries a new value.
      if (error instanceof SeamError && /duplicate|already|code_in_use/.test(error.type ?? "")) throw new CodeValueRefused(input.deviceId);
      throw error;
    }
  }

  async moveCode(input: { deviceId: string; codeId: string; window: CodeWindow }): Promise<CodeOnDevice> {
    await this.call("/access_codes/update", { access_code_id: input.codeId, ...this.timing(input.window) });
    return this.codeStatus(input);
  }

  async removeCode(input: { deviceId: string; codeId: string }): Promise<void> {
    try {
      await this.call("/access_codes/delete", { access_code_id: input.codeId });
    } catch (error) {
      // Already gone is fine.
      if (error instanceof SeamError && error.status === 404) return;
      throw error;
    }
  }

  async codeStatus(input: { deviceId: string; codeId: string }): Promise<CodeOnDevice> {
    try {
      const reply = await this.call<{ access_code: SeamAccessCode }>("/access_codes/get", { access_code_id: input.codeId });
      return { codeId: input.codeId, status: codeStatusOf(reply.access_code) };
    } catch (error) {
      if (error instanceof SeamError && error.status === 404) return { codeId: input.codeId, status: "removed" };
      throw error;
    }
  }

  async backupCode(input: { deviceId: string; codeId?: string; name: string; window: CodeWindow }): Promise<{ codeId: string; code: string } | undefined> {
    if (!input.codeId) return undefined;
    try {
      const reply = await this.call<{ backup_access_code?: SeamAccessCode }>("/access_codes/pull_backup_access_code", { access_code_id: input.codeId });
      const backup = reply.backup_access_code;
      return backup?.access_code_id && typeof backup.code === "string" ? { codeId: backup.access_code_id, code: backup.code } : undefined;
    } catch (error) {
      if (error instanceof SeamError && error.status < 500) return undefined;
      throw error;
    }
  }

  /**
   * Seam signs webhooks the Svix way: HMAC-SHA256 over `id.timestamp.body` with the secret after its
   * "whsec_" prefix, base64-decoded; the svix-signature header lists "v1,<base64>" signatures. A
   * webhook with no secret configured, a bad or old signature, or an unreadable body is refused.
   */
  parseWebhook(input: { headers: Record<string, string | string[] | undefined>; body: string }): LockWebhookEvent | undefined {
    const secret = this.options.webhookSecret?.trim();
    if (!secret) return undefined;
    const header = (name: string) => {
      const raw = input.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };
    const id = header("svix-id");
    const timestamp = header("svix-timestamp");
    const signatures = header("svix-signature");
    if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return undefined;
    if (Math.abs(this.now().getTime() - Number(timestamp) * 1000) > WEBHOOK_TOLERANCE_MS) return undefined;
    let key: Buffer;
    try {
      key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    } catch {
      return undefined;
    }
    const want = createHmac("sha256", key).update(`${id}.${timestamp}.${input.body}`).digest();
    const matched = signatures.split(" ").some((part) => {
      const [version, value] = part.split(",");
      if (version !== "v1" || !value) return false;
      const got = Buffer.from(value, "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
    if (!matched) return undefined;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(input.body) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    const eventId = str(raw.event_id) ?? id;
    const eventType = str(raw.event_type);
    if (!eventType) return undefined;
    const at = str(raw.occurred_at) ?? str(raw.created_at) ?? this.now().toISOString();
    const method = str(raw.method);
    const battery = typeof raw.battery_level === "number" ? raw.battery_level : undefined;
    return {
      id: eventId,
      kind: kindOf(eventType),
      partnerType: eventType,
      at,
      ...(str(raw.connected_account_id) ? { accountId: str(raw.connected_account_id)! } : {}),
      ...(str(raw.device_id) ? { deviceId: str(raw.device_id)! } : {}),
      ...(str(raw.access_code_id) ? { codeId: str(raw.access_code_id)! } : {}),
      ...(str(raw.access_code_name) ? { codeName: str(raw.access_code_name)! } : {}),
      ...(method ? { method } : {}),
      ...(eventType === "lock.unlocked" && method === "keycode" ? { side: "outside" as const } : {}),
      ...(battery !== undefined ? { battery } : {}),
      ...(str(raw.customer_key) ? { customerKey: str(raw.customer_key)! } : {}),
    };
  }
}

/** The partner's adapter from the service's environment, or undefined when the key isn't set. */
export function seamFromEnv(env: NodeJS.ProcessEnv): SeamLockAdapter | undefined {
  const apiKey = env.SEAM_API_KEY?.trim();
  if (!apiKey) return undefined;
  const webhookSecret = env.SEAM_WEBHOOK_SECRET?.trim();
  return new SeamLockAdapter({ apiKey, ...(webhookSecret ? { webhookSecret } : {}) });
}
