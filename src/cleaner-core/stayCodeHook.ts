/**
 * Where a smart-lock code for a stay moves or is revoked when an Airbnb email moves a cleaning's
 * window, a late checkout moves it, or a cancellation calls a cleaning off. Never handed a door code:
 * only the job and its window. With connected locks (#180) the hook asks for a lock sync for that job:
 * the property's desk then issues, moves or revokes the cleaner's code at the end of its step.
 */
export interface StayCodeHook {
  windowMoved(input: { jobId: string; window: { start: string; end: string | null } }): Promise<void>;
  stayCancelled(input: { jobId: string }): Promise<void>;
}

export const noStayCodeHook: StayCodeHook = {
  async windowMoved() {},
  async stayCancelled() {},
};

/** Jobs whose code a booking email or late checkout asked to be synced, until a desk takes them. */
const asks = new Set<string>();

const MAX_ASKS = 1000;

function ask(jobId: string): void {
  asks.delete(jobId);
  asks.add(jobId);
  // A property without connected locks never takes its asks: the oldest go first.
  while (asks.size > MAX_ASKS) asks.delete(asks.values().next().value as string);
}

/** The hook #180 fills in: each call asks for a lock sync of that job. */
export const lockSyncHook: StayCodeHook = {
  async windowMoved(input) {
    ask(input.jobId);
  },
  async stayCancelled(input) {
    ask(input.jobId);
  },
};

/** True, and clears them, when any of these jobs asked for a lock sync. */
export function takeLockSyncAsks(jobIds: readonly string[]): boolean {
  let any = false;
  for (const id of jobIds) if (asks.delete(id)) any = true;
  return any;
}

let current: StayCodeHook = lockSyncHook;

/** Tests set it; undefined puts the lock sync hook back. */
export function setStayCodeHook(hook: StayCodeHook | undefined): void {
  current = hook ?? lockSyncHook;
}

export function stayCodeHook(): StayCodeHook {
  return current;
}
