import type { AccountRef, CameraProvider } from "./adapter";
import type { Counter } from "./counter";
import { isCameraEvent, isCountLine, type CameraEventLine, type EventLog, type StoredLine } from "./lines";

/**
 * The counting pass (#239): for each stored motion event inside a stay (or the counting week), fetch the snapshot at its time, count it,
 * append a count line, and drop the image. Run on the clock tick and after a webhook is stored. An event is
 * tried three times in all, then left uncounted for the night's check to list. At most `cap` events are counted a
 * night; the rest wait for the next pass.
 */

/** Labels that never need a headcount: the doorbell, and a package drop (package arrivals reads those). */
const NOT_COUNTED = new Set(["package_delivery"]);
export const NIGHT_CAP = 60;
const TRIES = 3;

export function countable(line: CameraEventLine): boolean {
  return line.kind === "motion" && !(line.label && NOT_COUNTED.has(line.label));
}

export interface CountingDeps {
  provider: CameraProvider;
  account: AccountRef;
  counter: Counter;
  log: EventLog;
  /** Whether an event at a time is counted: inside a stay with a house rule the cameras can watch, or in the counting week. */
  inStay(at: string): boolean;
  /** The stay night a time belongs to, for the nightly cap. */
  nightOf(at: string): string;
  /** The local time for the counter's hint, like "9:14 PM". */
  localTime?(at: string): string;
  cap?: number;
  /** A night's cap for an event's time, when it differs from `cap` (the counting week's is higher). */
  capAt?(at: string): number | undefined;
}

export interface CountingRun {
  counted: number;
  failed: number;
  /** Events past the night's cap, left for the next pass. */
  waiting: number;
}

export class CameraCounting {
  /** Failed tries per event, in memory: a restart gives each event its tries again. */
  private readonly tries = new Map<string, number>();
  constructor(private readonly deps: CountingDeps) {}

  /** Events that still want a count: countable, in a stay, not yet counted, not out of tries. */
  pending(lines: StoredLine[] = this.deps.log.read()): CameraEventLine[] {
    // Counted by this counter: a second counter (for the counting test) counts the same events on its own.
    const counted = new Set(lines.filter(isCountLine).filter((line) => line.counter === this.deps.counter.name).map((line) => line.event));
    return lines.filter(isCameraEvent).filter((line) => countable(line) && !counted.has(line.id) && (this.tries.get(line.id) ?? 0) < TRIES && this.deps.inStay(line.at));
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** One pass at a time: an overlapping call waits for the one before, then reads the log afresh, so no event is fetched or counted twice. */
  run(): Promise<CountingRun> {
    const next = this.chain.then(() => this.pass());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async pass(): Promise<CountingRun> {
    const lines = this.deps.log.read();
    const cap = (at: string) => this.deps.capAt?.(at) ?? this.deps.cap ?? NIGHT_CAP;
    const used = new Map<string, number>();
    const eventNight = new Map(lines.filter(isCameraEvent).map((line) => [line.id, this.deps.nightOf(line.at)]));
    for (const line of lines.filter(isCountLine).filter((count) => count.counter === this.deps.counter.name)) {
      const night = eventNight.get(line.event);
      if (night) used.set(night, (used.get(night) ?? 0) + 1);
    }
    const result: CountingRun = { counted: 0, failed: 0, waiting: 0 };
    for (const line of this.pending(lines)) {
      const night = this.deps.nightOf(line.at);
      if ((used.get(night) ?? 0) >= cap(line.at)) {
        result.waiting += 1;
        continue;
      }
      try {
        const image = await this.deps.provider.snapshot(this.deps.account, line.deviceId, line.at);
        const counts = await this.deps.counter.count(image, { ...(line.label ? { label: line.label } : {}), ...(this.deps.localTime ? { local: this.deps.localTime(line.at) } : {}) });
        this.deps.log.append({ type: "camera-count", id: `count:${line.id}:${this.deps.counter.name}`, at: line.at, event: line.id, counter: this.deps.counter.name, ...counts });
        used.set(night, (used.get(night) ?? 0) + 1);
        result.counted += 1;
      } catch {
        this.tries.set(line.id, (this.tries.get(line.id) ?? 0) + 1);
        result.failed += 1;
      }
    }
    return result;
  }
}
