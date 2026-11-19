import { isOn } from "../cleaner-core/flag";
import type { LockAdapter } from "./adapter";

/**
 * The service's lock adapter. Unset means no property is on connected locks, whatever its files say.
 * The shared service sets the partner's adapter at startup only when SMART_LOCKS is on and its API key
 * is in the environment; tests set the fake.
 */

let current: LockAdapter | undefined;

export function setLockAdapter(adapter: LockAdapter | undefined): void {
  current = adapter;
}

export function lockAdapter(): LockAdapter | undefined {
  return current;
}

/** Connected locks on the service. Off unless SMART_LOCKS is exactly "1" or "true". */
export function smartLocksOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.SMART_LOCKS);
}
