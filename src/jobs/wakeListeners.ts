import type { CoreJob } from "./jobs";

/**
 * Who hears that a desk queued a wake-up for its routine (#250), by the desk's folder, as hub/doorAccess keeps its
 * secret savers. The shared service registers a listener for each property's folder; a desk only says that it woke
 * its routine and for which job. Nothing about the news itself passes through here.
 */

const listeners = new Map<string, (job: CoreJob) => void>();

export function onWake(root: string, listener: (job: CoreJob) => void): void {
  listeners.set(root, listener);
}

/** A desk queued a wake-up for `job`'s routine. A listener that throws never stops the desk. */
export function woke(root: string, job: CoreJob): void {
  try {
    listeners.get(root)?.(job);
  } catch {
    // The desk's own wake-up is already queued.
  }
}
