/**
 * Our own count of people, vehicles and animals in one camera snapshot (#239). The provider labels events but never
 * counts. The live counter is an open-source detector run on our own server (`detector.ts`): no image leaves it.
 */

export interface Counts {
  people: number;
  vehicles: number;
  animals: number;
  /** Set when a counted object was close to the detector's threshold, so the count deserves a second look. */
  confidence?: "low";
}

export interface Counter {
  /** The counter and its version, like "rfdetr-medium-t50-v1". Stored on each count line. */
  readonly name: string;
  count(image: Uint8Array, hint: { label?: string; local?: string }): Promise<Counts>;
}

/** A counter for tests: the counts come from the given function. */
export function fakeCounter(counts: (hint: { label?: string }) => Counts, name = "fake-v1"): Counter & { seen: number } {
  const counter = {
    name,
    seen: 0,
    async count(_image: Uint8Array, hint: { label?: string }) {
      counter.seen += 1;
      return counts(hint);
    },
  };
  return counter;
}
