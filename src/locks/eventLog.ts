import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LockWebhookEvent } from "./adapter";

/**
 * Lock events, stored as received, append-only, in the property's one event log: the store #237's
 * visit records read (`visit-events/<YYYY-MM>.jsonl`, the shape its design proposes). An unlock or
 * lock is a `lock` line (`LockEvent` in #237's design) with Property Core's fields added; every other
 * lock event (a code set, a battery reading, offline) is a `lock-status` line. A line is written once
 * per event id and never changed. No line holds a code, a digit run of 4 or more, or a phone number.
 */

export const VISIT_EVENTS_DIR = "visit-events";

/** What Property Core adds to a lock event: which grant's code it names, never the code. */
export interface GrantRef {
  flow: "cleaning" | "repair" | "standing";
  jobId: string;
  backup?: boolean;
}

/** An unlock or lock, in the shape #237's visit records read. */
export interface LockEventLine {
  type: "lock";
  id: string;
  at: string;
  loggedAt: string;
  /** The lock's name, like "Front door". */
  device: string;
  deviceId: string;
  action: "unlock" | "lock";
  side?: "outside" | "inside";
  /** The name the code carries on the lock. */
  codeName?: string;
  method?: string;
  /** The Property Core code that opened it, when it's one. */
  grant?: GrantRef;
  partnerType: string;
}

/** Every other lock event. */
export interface LockStatusLine {
  type: "lock-status";
  id: string;
  at: string;
  loggedAt: string;
  kind: Exclude<LockWebhookEvent["kind"], "unlock" | "lock">;
  device?: string;
  deviceId?: string;
  battery?: number;
  grant?: GrantRef;
  partnerType: string;
}

export type StoredLockLine = LockEventLine | LockStatusLine;

/** Takes any run of 4 or more digits out, so a code or a phone can't be stored even if a partner sends one. */
function clean(text: string | undefined, max = 120): string | undefined {
  if (text === undefined) return undefined;
  const out = text.replace(/\d[\d\s\-.()]{2,}\d/g, (run) => (run.replace(/\D/g, "").length >= 4 ? "[digits]" : run)).slice(0, max);
  return out || undefined;
}

export function lockLine(event: LockWebhookEvent, ctx: { deviceName?: string; grant?: GrantRef; loggedAt: string }): StoredLockLine {
  const device = clean(ctx.deviceName);
  const base = { id: clean(event.id, 200)!, at: event.at, loggedAt: ctx.loggedAt, partnerType: clean(event.partnerType, 80) ?? "unknown", ...(ctx.grant ? { grant: ctx.grant } : {}) };
  if (event.kind === "unlock" || event.kind === "lock") {
    const codeName = clean(event.codeName, 80);
    const method = clean(event.method, 40);
    return {
      type: "lock",
      ...base,
      device: device ?? "a door",
      deviceId: clean(event.deviceId, 200) ?? "",
      action: event.kind,
      ...(event.side ? { side: event.side } : {}),
      ...(codeName ? { codeName } : {}),
      ...(method ? { method } : {}),
    };
  }
  const deviceId = clean(event.deviceId, 200);
  return {
    type: "lock-status",
    ...base,
    kind: event.kind,
    ...(device ? { device } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(typeof event.battery === "number" && event.battery >= 0 && event.battery <= 1 ? { battery: event.battery } : {}),
  };
}

function monthFile(root: string, at: string): string {
  const month = /^\d{4}-\d{2}/.exec(at)?.[0] ?? new Date().toISOString().slice(0, 7);
  return join(root, VISIT_EVENTS_DIR, `${month}.jsonl`);
}

/** Appends the line unless its id is already in that month's log. True when written. */
export function appendLockLine(root: string, line: StoredLockLine): boolean {
  const path = monthFile(root, line.at);
  if (existsSync(path)) {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw) continue;
      try {
        if ((JSON.parse(raw) as { id?: string }).id === line.id) return false;
      } catch {
        // A line that won't parse is skipped, never rewritten.
      }
    }
  }
  mkdirSync(join(root, VISIT_EVENTS_DIR), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return true;
}

/** The stored lock lines from `since` to `until`, oldest first. Bad lines are skipped. */
export function readLockLines(root: string, since: Date, until?: Date): StoredLockLine[] {
  const dir = join(root, VISIT_EVENTS_DIR);
  if (!existsSync(dir)) return [];
  const first = since.toISOString().slice(0, 7);
  const last = until?.toISOString().slice(0, 7);
  const out: StoredLockLine[] = [];
  for (const name of readdirSync(dir).sort()) {
    const month = /^(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (!month || month < first || (last && month > last)) continue;
    for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as StoredLockLine;
        const at = Date.parse(line.at);
        if ((line.type === "lock" || line.type === "lock-status") && at >= since.getTime() && (!until || at <= until.getTime())) out.push(line);
      } catch {
        continue;
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
