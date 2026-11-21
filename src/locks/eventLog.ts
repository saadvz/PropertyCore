import type { LockEvent, LockStatusEvent } from "../visits/events";
import { VISIT_EVENTS_DIR, visitLogFor } from "../visits/store";
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

/** "new" when written, "duplicate" when its id was already in the log, "unstored" for a kind the log has no line for. */
export type Recorded = "new" | "duplicate" | "unstored";

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
