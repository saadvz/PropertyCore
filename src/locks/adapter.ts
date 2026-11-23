/**
 * The lock adapter: the one interface Property Core owns for a lock partner. The first implementation
 * is the partner's API (`seam.ts`); tests use the in-memory fake (`fake.ts`). No other code calls a
 * lock partner. Nothing here ever logs a code, and a code value only passes through `createCode`,
 * `backupCode` and the release that hands it to the person it was made for.
 */

/** ISO instants. */
export interface CodeWindow {
  from: string;
  until: string;
}

export type DeviceKind = "lock" | "thermostat" | "noise-sensor" | "other";

export interface LockDevice {
  /** The partner's device id. */
  id: string;
  /** The partner's account the device is in. */
  accountId: string;
  /** The name the host gave the device, like "Front door". Never a code. */
  name: string;
  kind: DeviceKind;
  online: boolean;
  /** 0 to 1 when the device reports it. */
  battery?: number;
  /** Code lengths the lock accepts, when it says. */
  codeLengths?: number[];
  /** Whether the lock offers backup codes. */
  backupCodes?: boolean;
}

/** Where one code is on one device. */
/** scheduled: made on the partner, waiting for its window to open before it goes on the lock. */
export type CodeStatus = "programming" | "scheduled" | "set" | "failed" | "removed";

export interface CodeOnDevice {
  /** The partner's id for this code on this device. */
  codeId: string;
  status: CodeStatus;
}

/** A create the lock refused because of the value itself (a clash with another code), not a failure. */
export class CodeValueRefused extends Error {
  constructor(readonly deviceId: string) {
    super("The lock refused that code value.");
  }
}

/** The kinds of lock event Property Core acts on. Anything else is stored as `other`. */
export type LockEventKind =
  | "code-set"
  | "code-failed"
  | "code-removed"
  | "backup-low"
  | "unlock"
  | "lock"
  | "battery-low"
  | "offline"
  | "online"
  | "account-connected"
  | "account-disconnected"
  /** A reconnected account finished its first sync: its devices are listed again, maybe under new ids (#280 22). */
  | "account-synced"
  | "other";

/** One webhook from the partner, verified and parsed. Holds no code digits. */
export interface LockWebhookEvent {
  /** The partner's own event id, so a resent webhook is stored once. */
  id: string;
  kind: LockEventKind;
  /** The partner's word for the event as given. */
  partnerType: string;
  /** ISO time the partner says it happened. */
  at: string;
  accountId?: string;
  deviceId?: string;
  /** The partner's id of the code that opened, set or failed. */
  codeId?: string;
  /** The partner's name of the code, as Property Core named it at create. */
  codeName?: string;
  /** "outside" covers the keypad and a lock-from-outside button. */
  side?: "outside" | "inside";
  /** The partner's word for how it was worked ("keypad", "app", "auto"). Kept, never read by a rule. */
  method?: string;
  /** Battery 0 to 1, for a battery event. */
  battery?: number;
  /** The Property Core account the partner's account is tagged with, when it says. */
  customerKey?: string;
}

export interface LockAdapter {
  /** A single-use link where the host signs in to their lock account. The link names the account, never a password. */
  connectLink(input: { customerKey: string; kind: "locks" | "sensors" }): Promise<{ url: string; linkId: string }>;
  /**
   * The partner's accounts the host signed in to, tagged with this Property Core account. None until a sign-in
   * finishes. `disconnected` when the partner still lists the account but it needs a new sign-in (#280 22).
   */
  accounts(input: { customerKey: string }): Promise<{ id: string; disconnected?: boolean }[]>;
  /** Removes a stuck connection, only one listed under this customer key; any other id is ignored (#280 22). */
  removeAccount(input: { customerKey: string; accountId: string }): Promise<void>;
  /** The devices in the partner's accounts tagged with this Property Core account, and no other account's. */
  devices(input: { customerKey: string }): Promise<LockDevice[]>;
  /** Puts `code` on the device for the window. Throws `CodeValueRefused` when the value clashes. */
  createCode(input: { deviceId: string; code: string; name: string; window: CodeWindow }): Promise<CodeOnDevice>;
  /** Changes a code's window. */
  moveCode(input: { deviceId: string; codeId: string; window: CodeWindow }): Promise<CodeOnDevice>;
  /** Removes a code. Removing one that's already gone is not an error. */
  removeCode(input: { deviceId: string; codeId: string }): Promise<void>;
  /** Where the code is now. */
  codeStatus(input: { deviceId: string; codeId: string }): Promise<CodeOnDevice>;
  /**
   * A backup code for a device whose code failed: `codeId` is the failed code's id on the device, when
   * it was made. Undefined when the pool is empty or the lock has none.
   */
  backupCode(input: { deviceId: string; codeId?: string; name: string; window: CodeWindow }): Promise<{ codeId: string; code: string } | undefined>;
  /** Verifies and parses a webhook. Undefined when the signature, its age or its body is wrong: nothing is read then. */
  parseWebhook(input: { headers: Record<string, string | string[] | undefined>; body: string }): LockWebhookEvent | undefined;
}
