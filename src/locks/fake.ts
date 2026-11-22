import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { CodeValueRefused, type CodeOnDevice, type CodeStatus, type CodeWindow, type LockAdapter, type LockDevice, type LockWebhookEvent } from "./adapter";

/**
 * An in-memory lock partner for tests and Scratch. It never reaches a network. Codes it holds are
 * whatever the caller made at runtime; backup codes are random digits made here. A test drives it:
 * a device can program slowly, fail, refuse a value once, go offline, or run out of backup codes.
 */

interface FakeCode {
  codeId: string;
  deviceId: string;
  code: string;
  name: string;
  window: CodeWindow;
  status: CodeStatus;
  backup?: boolean;
}

export interface FakeCall {
  op: "connectLink" | "accounts" | "devices" | "createCode" | "moveCode" | "removeCode" | "codeStatus" | "backupCode";
  deviceId?: string;
  codeId?: string;
}

export const FAKE_SIGNATURE_HEADER = "x-fake-lock-signature";

export class FakeLockAdapter implements LockAdapter {
  readonly calls: FakeCall[] = [];
  private readonly byKey = new Map<string, LockDevice[]>();
  private listBroken = false;
  private readonly codes = new Map<string, FakeCode>();
  private readonly behaviour = new Map<string, { programming?: boolean; fail?: boolean; refuseValues?: number; backups?: number; throwOn?: Set<FakeCall["op"]> }>();
  private seq = 0;

  constructor(private readonly webhookSecret = "fake-webhook-secret") {}

  /** Adds a device to the partner account tagged with `customerKey`. */
  addDevice(customerKey: string, device: Omit<LockDevice, "accountId" | "kind" | "online"> & Partial<Pick<LockDevice, "accountId" | "kind" | "online">>): LockDevice {
    const full: LockDevice = { accountId: `acct-${customerKey}`, kind: "lock", online: true, backupCodes: true, ...device };
    this.byKey.set(customerKey, [...(this.byKey.get(customerKey) ?? []), full]);
    if (!this.behaviour.has(full.id)) this.behaviour.set(full.id, { backups: 2 });
    return full;
  }

  /** A partner account the host signed in to, tagged with `customerKey`, with no devices yet. */
  addAccount(customerKey: string): void {
    if (!this.byKey.has(customerKey)) this.byKey.set(customerKey, []);
  }

  /** The next accounts or devices list throws, as a partner error would. */
  breakAccounts(): void {
    this.listBroken = true;
  }

  /** New codes on this device stay `programming` until `settle`. */
  programSlowly(deviceId: string, on = true): void {
    this.tune(deviceId).programming = on;
  }

  /** New codes on this device end `failed`. */
  failCodes(deviceId: string, on = true): void {
    this.tune(deviceId).fail = on;
  }

  /** The next `times` creates on this device refuse the value. */
  refuseValues(deviceId: string, times = 1): void {
    this.tune(deviceId).refuseValues = times;
  }

  /** How many backup codes the device has left. */
  setBackups(deviceId: string, count: number): void {
    this.tune(deviceId).backups = count;
  }

  /** The next call of this kind on this device throws, as a network or partner failure would. */
  breakOn(deviceId: string, op: FakeCall["op"]): void {
    (this.tune(deviceId).throwOn ??= new Set()).add(op);
  }

  setOnline(deviceId: string, online: boolean): void {
    for (const devices of this.byKey.values()) for (const device of devices) if (device.id === deviceId) device.online = online;
  }

  setBattery(deviceId: string, battery: number): void {
    for (const devices of this.byKey.values()) for (const device of devices) if (device.id === deviceId) device.battery = battery;
  }

  /** Every programming code on the device becomes `status`. */
  settle(deviceId: string, status: "set" | "failed" = "set"): void {
    for (const code of this.codes.values()) if (code.deviceId === deviceId && code.status === "programming") code.status = status;
  }

  /** The live codes on a device, for a test to check. Tests only: never logged. */
  liveCodes(deviceId: string): { codeId: string; code: string; name: string; window: CodeWindow; status: CodeStatus; backup: boolean }[] {
    return [...this.codes.values()]
      .filter((code) => code.deviceId === deviceId && code.status !== "removed")
      .map((code) => ({ codeId: code.codeId, code: code.code, name: code.name, window: { ...code.window }, status: code.status, backup: code.backup === true }));
  }

  async connectLink(input: { customerKey: string; kind: "locks" | "sensors" }): Promise<{ url: string; linkId: string }> {
    this.calls.push({ op: "connectLink" });
    const linkId = `link-${++this.seq}`;
    return { url: `https://connect.example.com/${input.kind}/${linkId}`, linkId };
  }

  async accounts(input: { customerKey: string }): Promise<{ id: string }[]> {
    this.calls.push({ op: "accounts" });
    this.maybeBreakList();
    if (!this.byKey.has(input.customerKey)) return [];
    const ids = new Set([`acct-${input.customerKey}`, ...(this.byKey.get(input.customerKey) ?? []).map((device) => device.accountId)]);
    return [...ids].map((id) => ({ id }));
  }

  async devices(input: { customerKey: string }): Promise<LockDevice[]> {
    this.calls.push({ op: "devices" });
    this.maybeBreakList();
    return (this.byKey.get(input.customerKey) ?? []).map((device) => ({ ...device }));
  }

  async createCode(input: { deviceId: string; code: string; name: string; window: CodeWindow }): Promise<CodeOnDevice> {
    this.calls.push({ op: "createCode", deviceId: input.deviceId });
    const tune = this.tune(input.deviceId);
    this.maybeThrow(input.deviceId, "createCode");
    if ((tune.refuseValues ?? 0) > 0) {
      tune.refuseValues = (tune.refuseValues ?? 0) - 1;
      throw new CodeValueRefused(input.deviceId);
    }
    const taken = [...this.codes.values()].some((code) => code.deviceId === input.deviceId && code.status !== "removed" && code.code === input.code);
    if (taken) throw new CodeValueRefused(input.deviceId);
    const codeId = `code-${++this.seq}`;
    const status: CodeStatus = tune.programming ? "programming" : tune.fail ? "failed" : "set";
    this.codes.set(codeId, { codeId, deviceId: input.deviceId, code: input.code, name: input.name, window: { ...input.window }, status });
    return { codeId, status };
  }

  async moveCode(input: { deviceId: string; codeId: string; window: CodeWindow }): Promise<CodeOnDevice> {
    this.calls.push({ op: "moveCode", deviceId: input.deviceId, codeId: input.codeId });
    this.maybeThrow(input.deviceId, "moveCode");
    const code = this.codes.get(input.codeId);
    if (!code || code.deviceId !== input.deviceId || code.status === "removed") throw new Error("No such code.");
    code.window = { ...input.window };
    return { codeId: code.codeId, status: code.status };
  }

  async removeCode(input: { deviceId: string; codeId: string }): Promise<void> {
    this.calls.push({ op: "removeCode", deviceId: input.deviceId, codeId: input.codeId });
    this.maybeThrow(input.deviceId, "removeCode");
    const code = this.codes.get(input.codeId);
    if (code && code.deviceId === input.deviceId) code.status = "removed";
  }

  async codeStatus(input: { deviceId: string; codeId: string }): Promise<CodeOnDevice> {
    this.calls.push({ op: "codeStatus", deviceId: input.deviceId, codeId: input.codeId });
    this.maybeThrow(input.deviceId, "codeStatus");
    const code = this.codes.get(input.codeId);
    if (!code || code.deviceId !== input.deviceId) return { codeId: input.codeId, status: "removed" };
    return { codeId: code.codeId, status: code.status };
  }

  async backupCode(input: { deviceId: string; codeId?: string; name: string; window: CodeWindow }): Promise<{ codeId: string; code: string } | undefined> {
    this.calls.push({ op: "backupCode", deviceId: input.deviceId });
    this.maybeThrow(input.deviceId, "backupCode");
    const tune = this.tune(input.deviceId);
    if ((tune.backups ?? 0) <= 0) return undefined;
    tune.backups = (tune.backups ?? 0) - 1;
    const codeId = `backup-${++this.seq}`;
    const code = String(randomInt(100000, 1000000));
    this.codes.set(codeId, { codeId, deviceId: input.deviceId, code, name: input.name, window: { ...input.window }, status: "set", backup: true });
    return { codeId, code };
  }

  /** A signed webhook body for `event`, as the fake partner would post it. */
  webhook(event: LockWebhookEvent): { headers: Record<string, string>; body: string } {
    const body = JSON.stringify(event);
    return { headers: { [FAKE_SIGNATURE_HEADER]: this.sign(body) }, body };
  }

  parseWebhook(input: { headers: Record<string, string | string[] | undefined>; body: string }): LockWebhookEvent | undefined {
    const raw = input.headers[FAKE_SIGNATURE_HEADER];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (!given) return undefined;
    const want = Buffer.from(this.sign(input.body));
    const got = Buffer.from(given);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try {
      const parsed = JSON.parse(input.body) as LockWebhookEvent;
      return typeof parsed.id === "string" && typeof parsed.kind === "string" && typeof parsed.at === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", this.webhookSecret).update(body).digest("base64");
  }

  private tune(deviceId: string) {
    let entry = this.behaviour.get(deviceId);
    if (!entry) {
      entry = { backups: 2 };
      this.behaviour.set(deviceId, entry);
    }
    return entry;
  }

  private maybeBreakList(): void {
    if (!this.listBroken) return;
    this.listBroken = false;
    throw new Error("The lock partner didn't answer.");
  }

  private maybeThrow(deviceId: string, op: FakeCall["op"]): void {
    const set = this.tune(deviceId).throwOn;
    if (set?.has(op)) {
      set.delete(op);
      throw new Error("The lock partner didn't answer.");
    }
  }
}
