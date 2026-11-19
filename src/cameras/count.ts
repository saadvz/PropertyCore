import type { AccountRef, CameraProvider } from "./adapter";
import type { Counter } from "./counter";
import { isCameraEvent, isCountLine, type CameraEventLine, type EventLog, type StoredLine } from "./lines";

/**
 * The counting pass (#239): for each stored motion event inside a stay, fetch the snapshot at its time, count it,
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
  /** Whether a time falls inside a stay with a house rule the cameras can watch. */
  inStay(at: string): boolean;
  /** The stay night a time belongs to, for the nightly cap. */
  nightOf(at: string): string;
  /** The local time for the counter's hint, like "9:14 PM". */
  localTime?(at: string): string;
  cap?: number;
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
    const counted = new Set(lines.filter(isCountLine).map((line) => line.event));
    return lines.filter(isCameraEvent).filter((line) => countable(line) && !counted.has(line.id) && (this.tries.get(line.id) ?? 0) < TRIES && this.deps.inStay(line.at));
  }

  async run(): Promise<CountingRun> {
    const lines = this.deps.log.read();
    const cap = this.deps.cap ?? NIGHT_CAP;
    const used = new Map<string, number>();
    const eventNight = new Map(lines.filter(isCameraEvent).map((line) => [line.id, this.deps.nightOf(line.at)]));
    for (const line of lines.filter(isCountLine)) {
      const night = eventNight.get(line.event);
      if (night) used.set(night, (used.get(night) ?? 0) + 1);
    }
    const result: CountingRun = { counted: 0, failed: 0, waiting: 0 };
    for (const line of this.pending(lines)) {
      const night = this.deps.nightOf(line.at);
      if ((used.get(night) ?? 0) >= cap) {
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
