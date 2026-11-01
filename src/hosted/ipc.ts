import type { OperatorEvent } from "../alerts/operatorEvents";

/**
 * Messages between the shared service and a touring process it started, over the fork IPC channel.
 * No secret, phone number, or door code ever travels here: an event is the same minimal JSON a
 * routine gets, and the alerts flag only says whether the tenant's routine is connected.
 */

/** The header that carries a touring process's key. The shared service sets it on every request it forwards. */
export const WORKER_KEY_HEADER = "x-tourcore-worker-key";

/** Carries the key again on the front's own internal calls. Never forwarded from a caller, so /t/<id>/ links can't reach /internal/. */
export const WORKER_INTERNAL_HEADER = "x-tourcore-internal";

/**
 * Which chat the call is from, as its sign-in recorded it. The touring process never sees the
 * sign-in, so this stands in for the stored client name that picks its playbook. Only the front sets it.
 */
export const WORKER_CLIENT_HEADER = "x-tourcore-client";

/** The client name each chat's sign-in stands for. Muse has no Tour Core playbook yet, so it gets the baseline. */
export const WORKER_CLIENT_NAMES: Readonly<Record<string, string>> = { grok: "Grok", claude: "Claude", chatgpt: "ChatGPT", muse: "Muse" };

/** From the touring process to the shared service. */
export type ToParent =
  | { type: "ready"; port: number }
  | { type: "event"; id: string; event: OperatorEvent }
  | { type: "log"; line: string };

/** From the shared service to the touring process. */
export type ToWorker =
  | { type: "event-ack"; id: string; ok: true }
  | { type: "event-ack"; id: string; ok: false; retryable: boolean; message: string }
  | { type: "alerts"; connected: boolean };
