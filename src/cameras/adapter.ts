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

/** The provider's own account behind a set of tokens. */
export interface CameraProfile {
  accountId: string;
  /** Shown to the host partly masked, so they can see which account is being connected. Never stored or logged. */
  email?: string;
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
  /** True when a client id the provider posted is this app's own. */
  ownsClient(clientId: string): boolean;
  /** Trades the code the provider posted to us for tokens (#302). The code works once, for 60 seconds. */
  exchangeCode(code: string): Promise<Tokens>;
  /** Who the tokens belong to at the provider, read over the token, never from a browser. */
  profile(account: AccountRef): Promise<CameraProfile>;
  /** The nonce the provider signs for an account at a time, to match its browser redirect to waiting tokens. */
  linkNonce(time: string, accountId: string): string;
  /** Tells the provider the link is ours and complete: without it, it shares no camera and sends no event. */
  confirmLink(account: AccountRef, input: { nonce: string; accountIdentifier: string }): Promise<void>;
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
