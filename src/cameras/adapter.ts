import type { CameraKind } from "./lines";

/**
 * The camera adapter (#239): the only way Property Core talks to a camera provider. Ring is the first
 * implementation (`ring.ts`); every test uses the in-memory fake (`fake.ts`). Nothing else calls the provider.
 * Media stays with the provider: a snapshot is fetched for counting and dropped, a clip is fetched only to pin.
 */

export interface Tokens {
  access: string;
  refresh: string;
  /** Epoch ms when the access token stops working. */
  expiresAt: number;
}

/** Where one linked account's tokens live: sealed in the tenant's secrets. The provider saves a refresh before using it. */
export interface TokenStore {
  get(): Tokens | undefined;
  save(tokens: Tokens): void;
}

export interface AccountRef {
  tokens: TokenStore;
}

export interface CameraDevice {
  /** The provider's id. */
  id: string;
  /** The name the host gave it in the provider's app. */
  name: string;
}

/** One event as the provider reports it, before it is a stored line. */
export interface CameraEvent {
  id: string;
  /** ISO time, UTC. */
  at: string;
  deviceId: string;
  kind: CameraKind;
  label?: string;
}

export type CameraWebhook =
  | { type: "event"; accountId?: string; event: CameraEvent }
  /** The host removed the app from their provider account. */
  | { type: "unlinked"; accountId: string }
  /** A signed delivery this adapter doesn't use, like a plan change. */
  | { type: "ignored" };

/** A clip by reference: what to ask the provider for, never the video. */
export interface ClipRef {
  deviceId: string;
  from: string;
  until: string;
}

export interface CameraProvider {
  readonly name: string;
  /** The page the host signs in on: the provider's own. `state` ties the return to our one-time link. */
  linkUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Trades the provider's code for tokens. */
  finishLink(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<Tokens>;
  devices(account: AccountRef): Promise<CameraDevice[]>;
  /** Verifies a webhook delivery before reading it. Unsigned, badly signed or unreadable: undefined. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): CameraWebhook | undefined;
  /** Events on one camera since a time, to fill gaps. The provider may give no labels here. */
  history(account: AccountRef, deviceId: string, since: string): Promise<CameraEvent[]>;
  /** One still image at a moment. Never stored. */
  snapshot(account: AccountRef, deviceId: string, at: string): Promise<Uint8Array>;
  /** Clip bytes for a range, only for pinning. */
  clip(account: AccountRef, ref: ClipRef): Promise<Uint8Array>;
  status(account: AccountRef, deviceId: string): Promise<"online" | "offline">;
}

/** A provider call that failed in a way the caller should say plainly. Never carries a token or a body. */
export class CameraProviderError extends Error {
  constructor(
    message: string,
    readonly reason: "unlinked" | "plan-required" | "offline" | "rate-limited" | "failed",
  ) {
    super(message);
    this.name = "CameraProviderError";
  }
}
