/**
 * Where a smart-lock code for a stay would move or be revoked when an Airbnb email moves a cleaning's
 * window or a cancellation calls a cleaning off. That waits on the lock partner (#180), so the default
 * does nothing. Never handed a door code: only the job and its window.
 */
export interface StayCodeHook {
  windowMoved(input: { jobId: string; window: { start: string; end: string | null } }): Promise<void>;
  stayCancelled(input: { jobId: string }): Promise<void>;
}

export const noStayCodeHook: StayCodeHook = {
  async windowMoved() {},
  async stayCancelled() {},
};

let current: StayCodeHook = noStayCodeHook;

/** Tests and #180 set it; undefined puts the do-nothing hook back. */
export function setStayCodeHook(hook: StayCodeHook | undefined): void {
  current = hook ?? noStayCodeHook;
}

export function stayCodeHook(): StayCodeHook {
  return current;
}
