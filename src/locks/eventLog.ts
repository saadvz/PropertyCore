import type { LockEvent, LockStatusEvent, VisitEvent } from "../visits/events";
import { cleanEvent, VISIT_EVENTS_DIR, visitLogFor } from "../visits/store";
import type { LockWebhookEvent } from "./adapter";

/**
 * Lock events (#180) go into the property's one event log, the visit log #237 reads
 * (`visit-events/<YYYY-MM>.jsonl`), through `VisitLog.append`: written once per event id, append-only,
 * with every name through the digit-run redaction. An unlock or lock is a `lock` line; a code set or
 * failed, the battery, offline or online, and the backup pool low are `lock-status` lines; a lock account
 * connected or disconnected is a `lock-connection` line. These lines are written for an account
 * with connected locks on, and like every visit log line they need no other switch.
 */

export { VISIT_EVENTS_DIR };

/**
 * "new" when written, "duplicate" when its id was already in the log, "echo" when it's a second report of a lock or
 * unlock the log already holds under another id, "unstored" for a kind the log has no line for.
 */
export type Recorded = "new" | "duplicate" | "echo" | "unstored";

/**
 * Two reports of one turn of the lock land this close together. The lock partner sends a lock done from its console as
 * two `lock.locked` events with different ids (25 Nov live run): their times were 0.4 s apart and the webhooks arrived
 * 36 to 107 ms apart. Ten seconds leaves room for a slower partner without folding in a second, real lock.
 */
export const LOCK_ECHO_MS = 10_000;

/** Lock and unlock are told apart; an unlock also by whose code and how, so a second person's entry is never folded in. */
function sameTurn(a: LockEvent, b: LockEvent): boolean {
  if (a.device !== b.device || a.action !== b.action) return false;
  return a.action === "lock" || ((a.codeName ?? "") === (b.codeName ?? "") && (a.method ?? "") === (b.method ?? "") && (a.side ?? "") === (b.side ?? ""));
}

/**
 * A line the log already holds for this same turn of the lock: the same door doing the same thing (for an unlock, with
 * the same code and the same way) within LOCK_ECHO_MS, with nothing else at that door between them.
 */
function echoOf(lines: readonly VisitEvent[], line: LockEvent): boolean {
  const at = Date.parse(line.at);
  const door = lines.filter((event): event is LockEvent => event.type === "lock" && event.device === line.device);
  return door.some((other) => {
    const then = Date.parse(other.at);
    if (!sameTurn(other, line) || Math.abs(at - then) > LOCK_ECHO_MS) return false;
    const [from, until] = then <= at ? [then, at] : [at, then];
    return !door.some((between) => between.action !== line.action && Date.parse(between.at) >= from && Date.parse(between.at) <= until);
  });
}

const STATUS_KINDS: Partial<Record<LockWebhookEvent["kind"], LockStatusEvent["kind"]>> = {
  "code-set": "code-set",
  "code-failed": "code-failed",
  "battery-low": "battery",
  offline: "offline",
  online: "online",
  "backup-low": "pool-low",
};

/**
 * Writes one verified event. `codeName` is the name Property Core gave the code on the lock, when the
 * event names one of its codes; it wins over the partner's own name, so the log matches `visit-codes.json`.
 */
export function recordLockEvent(root: string, event: LockWebhookEvent, ctx: { deviceName?: string; codeName?: string; now: () => Date }): Recorded {
  const log = visitLogFor(root, ctx.now);
  const device = ctx.deviceName ?? "a door";
  const codeName = ctx.codeName ?? event.codeName;
  if (event.kind === "unlock" || event.kind === "lock") {
    const line: LockEvent = { type: "lock", id: event.id, at: event.at, device, action: event.kind, ...(event.side ? { side: event.side } : {}), ...(codeName ? { codeName } : {}), ...(event.method ? { method: event.method } : {}) };
    const lines = log.read();
    if (lines.some((other) => other.id === event.id)) return "duplicate";
    // Compared as the log would write it, so the door's name matches the lines already there.
    const clean = cleanEvent(line);
    if (clean?.type === "lock" && echoOf(lines, clean)) return "echo";
    return log.append(line) ? "new" : "duplicate";
  }
  if (event.kind === "account-connected" || event.kind === "account-disconnected") {
    return log.append({ type: "lock-connection", id: event.id, at: event.at, connected: event.kind === "account-connected" }) ? "new" : "duplicate";
  }
  const kind = STATUS_KINDS[event.kind];
  if (!kind) return "unstored";
  const battery = typeof event.battery === "number" && event.battery >= 0 && event.battery <= 1 ? Math.round(event.battery * 100) : undefined;
  const line: LockStatusEvent = { type: "lock-status", id: event.id, at: event.at, kind, device, ...(codeName && (kind === "code-set" || kind === "code-failed") ? { codeName } : {}), ...(battery !== undefined ? { battery } : {}) };
  return log.append(line) ? "new" : "duplicate";
}

/** A property switched to connected locks, or back: visit records count a lock as connected from the latest such line. */
export function recordLockConnection(root: string, connected: boolean, now: () => Date): boolean {
  const at = now().toISOString();
  return visitLogFor(root, now).append({ type: "lock-connection", id: `pc-locks:${connected ? "on" : "off"}:${at}`, at, connected });
}

/** The lock lines from `since` to `until`, oldest first. */
export function lockLines(root: string, since: Date, until?: Date): (LockEvent & { loggedAt: string })[] {
  return visitLogFor(root)
    .read()
    .flatMap((event) => (event.type === "lock" ? [event] : []))
    .filter((event) => Date.parse(event.at) >= since.getTime() && (!until || Date.parse(event.at) <= until.getTime()))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
