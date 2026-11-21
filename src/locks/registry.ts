import type { LockAdapter } from "./adapter";

/**
 * The service's lock adapter. Unset means no property is on connected locks, whatever its files say.
 * The shared service sets the partner's adapter at startup only when its API key and webhook secret are
 * in the environment; tests set the fake. Each account's "locks" switch (featureOn) still decides.
 */

let current: LockAdapter | undefined;

export function setLockAdapter(adapter: LockAdapter | undefined): void {
  current = adapter;
}

export function lockAdapter(): LockAdapter | undefined {
  return current;
}
