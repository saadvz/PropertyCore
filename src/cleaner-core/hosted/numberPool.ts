import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../../core/phone";
import { writeJsonAtomic } from "../../storage/atomicWrite";

/**
 * Text lines that are already registered for business texting (10DLC or toll-free verification),
 * waiting for an account. Registration takes days, so numbers are bought and registered ahead of time
 * and added here from /admin. Each account takes one line when it is created, and gives it back when
 * it closes. One small JSON file beside tenants.json, read on every call like the registry.
 */

export interface PoolNumber {
  /** E.164. */
  number: string;
  /** Twilio's IncomingPhoneNumber sid, so pointing the webhook needs no lookup. */
  sid: string;
  addedAt: string;
  /** The account the line belongs to. Absent while it waits in the pool. */
  tenantId?: string;
  assignedAt?: string;
  /** When an account last gave it back. It rests before anyone else gets it. */
  returnedAt?: string;
  /** False when Twilio didn't take the webhook on the last attempt. */
  webhookOk?: boolean;
}

export type PoolState = "ready" | "resting" | "in-use";

export interface PoolSummary {
  ready: number;
  resting: number;
  inUse: number;
  /** True once ready numbers are at or below POOL_LOW_AT. */
  low: boolean;
}

interface Doc {
  schemaVersion: 1;
  numbers: PoolNumber[];
}

/** At or below this many ready numbers, /admin and the log say to add more. */
export const POOL_LOW_AT = 3;
/**
 * A returned line rests this long before another account gets it, so the old account's cleaner
 * stops texting it first. Their texts in that time reach no account.
 */
export const REST_MS = 30 * 24 * 60 * 60_000;

export class PoolError extends Error {
  constructor(readonly reason: "bad-number" | "already-pooled" | "in-use" | "not-pooled") {
    super(reason);
    this.name = "PoolError";
  }
}

export class NumberPool {
  private readonly file: string;

  constructor(
    dataRoot: string,
    private readonly now: () => Date,
  ) {
    this.file = join(dataRoot, "number-pool.json");
  }

  private read(): Doc {
    if (!existsSync(this.file)) return { schemaVersion: 1, numbers: [] };
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as { numbers?: PoolNumber[] };
    return { schemaVersion: 1, numbers: Array.isArray(raw.numbers) ? raw.numbers : [] };
  }

  private write(doc: Doc): void {
    writeJsonAtomic(this.file, doc);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  stateOf(entry: PoolNumber): PoolState {
    if (entry.tenantId) return "in-use";
    if (entry.returnedAt && this.now().getTime() - Date.parse(entry.returnedAt) < REST_MS) return "resting";
    return "ready";
  }

  /** When a resting line can be handed out again. */
  readyAt(entry: PoolNumber): string | undefined {
    if (this.stateOf(entry) !== "resting") return undefined;
    return new Date(Date.parse(entry.returnedAt!) + REST_MS).toISOString();
  }

  list(): PoolNumber[] {
    return this.read().numbers;
  }

  get(raw: string): PoolNumber | undefined {
    const number = parsePhone(raw);
    return number ? this.read().numbers.find((n) => n.number === number) : undefined;
  }

  summary(): PoolSummary {
    const counts = { ready: 0, resting: 0, inUse: 0 };
    for (const entry of this.read().numbers) {
      const state = this.stateOf(entry);
      if (state === "ready") counts.ready++;
      else if (state === "resting") counts.resting++;
      else counts.inUse++;
    }
    return { ...counts, low: counts.ready <= POOL_LOW_AT };
  }

  /** Tops up the pool with one registered number. The caller has checked it is on the Twilio account. */
  add(raw: string, sid: string): PoolNumber {
    const number = parsePhone(raw);
    if (!number) throw new PoolError("bad-number");
    const doc = this.read();
    if (doc.numbers.some((n) => n.number === number)) throw new PoolError("already-pooled");
    const entry: PoolNumber = { number, sid, addedAt: this.stamp() };
    doc.numbers.push(entry);
    this.write(doc);
    return entry;
  }

  /** The ready line that has waited longest, or undefined when none is ready. Changes nothing. */
  next(): PoolNumber | undefined {
    const ready = this.read().numbers.filter((n) => this.stateOf(n) === "ready");
    const since = (n: PoolNumber) => Date.parse(n.returnedAt ?? n.addedAt);
    return ready.sort((a, b) => since(a) - since(b))[0];
  }

  /**
   * Gives the line to an account. It must not belong to another one. A number typed on /admin that
   * isn't in the pool is added with it, so the pool knows every line in use.
   */
  assign(raw: string, sid: string, tenantId: string): PoolNumber {
    const number = parsePhone(raw);
    if (!number) throw new PoolError("bad-number");
    const doc = this.read();
    let entry = doc.numbers.find((n) => n.number === number);
    if (entry?.tenantId && entry.tenantId !== tenantId) throw new PoolError("in-use");
    if (!entry) {
      entry = { number, sid, addedAt: this.stamp() };
      doc.numbers.push(entry);
    }
    entry.sid = sid;
    entry.tenantId = tenantId;
    entry.assignedAt = this.stamp();
    delete entry.returnedAt;
    delete entry.webhookOk;
    this.write(doc);
    return entry;
  }

  /** Records whether Twilio took the line's webhook. */
  setWebhook(raw: string, ok: boolean): void {
    const number = parsePhone(raw);
    const doc = this.read();
    const entry = doc.numbers.find((n) => n.number === number);
    if (!entry) return;
    entry.webhookOk = ok;
    this.write(doc);
  }

  /** A closed account's line goes back to the pool, to rest before anyone else gets it. */
  giveBack(raw: string, sid: string): PoolNumber {
    const number = parsePhone(raw);
    if (!number) throw new PoolError("bad-number");
    const doc = this.read();
    let entry = doc.numbers.find((n) => n.number === number);
    if (!entry) {
      entry = { number, sid, addedAt: this.stamp() };
      doc.numbers.push(entry);
    }
    delete entry.tenantId;
    delete entry.assignedAt;
    delete entry.webhookOk;
    entry.returnedAt = this.stamp();
    this.write(doc);
    return entry;
  }

  /** Takes a line out of the pool for good, after Twilio released it. Never one an account is using. */
  remove(raw: string): PoolNumber {
    const number = parsePhone(raw);
    const doc = this.read();
    const entry = doc.numbers.find((n) => n.number === number);
    if (!entry) throw new PoolError("not-pooled");
    if (entry.tenantId) throw new PoolError("in-use");
    doc.numbers = doc.numbers.filter((n) => n !== entry);
    this.write(doc);
    return entry;
  }
}
