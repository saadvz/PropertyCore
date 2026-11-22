import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeNames, CodePerson, MediaRef, StoredEvent, VisitEvent } from "./events";
import { codeKey } from "./events";

/**
 * The append-only log behind visit records (#237): `visit-events/<YYYY-MM>.jsonl` in the property's folder, one
 * file per month written. A line is written once and never edited or removed. A line that won't parse is skipped and
 * counted, never repaired. An id already in the log is not written again, so a resent webhook or a replay adds
 * nothing. No line holds a door code, a run of 4 or more digits in a name or body, or a phone number. The store has
 * no flag: each writer checks its own (texts and windows always, locks with the account's locks on, cameras with its cameras on).
 */

export const VISIT_EVENTS_DIR = "visit-events";

/** A message event's id: a hash of the sender's own id, which can hold a phone number (an outbox id like "opt-in:+1..."). */
export function messageEventId(direction: "in" | "out", sourceId: string): string {
  return `${direction}:${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}
export const VISIT_CODES_FILE = "visit-codes.json";
const SALT_FILE = "salt";
const MAX_ID = 200;
const MAX_NAME = 80;
const MAX_BODY = 500;
const MAX_LABEL = 40;

/** Every run of 4 or more digits, even split by spaces, dots, dashes, underscores or slashes. The same rule as Cleaner Core's. */
export function redactDigitRuns(text: string): string {
  return text.replace(/\d(?:[\s.\-_/‐-―]*\d){3,}/g, "[redacted]");
}

const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
const cleanName = (value: string): string => redactDigitRuns(value).trim().slice(0, MAX_NAME);
/** A provider's opaque device id. It is kept as given (often long digits) because snapshot and clip calls need it. */
const isDeviceId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);

/** The event as it may be written: checked, with names and bodies cleaned. Undefined when it can't be written. */
export function cleanEvent(event: VisitEvent, redact: (text: string) => string = (text) => text): VisitEvent | undefined {
  if (!event || typeof event !== "object" || !isId(event.id) || !isTime(event.at)) return undefined;
  switch (event.type) {
    case "lock": {
      if (event.action !== "unlock" && event.action !== "lock") return undefined;
      if (typeof event.device !== "string" || !event.device.trim()) return undefined;
      if (event.side !== undefined && event.side !== "outside" && event.side !== "inside") return undefined;
      const codeName = typeof event.codeName === "string" && event.codeName.trim() ? cleanName(event.codeName) : undefined;
      const method = typeof event.method === "string" && event.method.trim() ? cleanName(event.method) : undefined;
      return {
        type: "lock",
        id: event.id,
        at: event.at,
        device: cleanName(event.device),
        action: event.action,
        ...(event.side ? { side: event.side } : {}),
        ...(codeName ? { codeName } : {}),
        ...(method ? { method } : {}),
      };
    }
    case "lock-connection":
      return typeof event.connected === "boolean" ? { type: "lock-connection", id: event.id, at: event.at, connected: event.connected } : undefined;
    case "message": {
      if (event.direction !== "in" && event.direction !== "out") return undefined;
      if (!["cleaner", "pro", "host", "observer", "group"].includes(event.role)) return undefined;
      if (typeof event.label !== "string" || !/^[a-z-]{1,40}$/.test(event.label) || event.label.length > MAX_LABEL) return undefined;
      // A door-code text is logged by what it was, never by what it said.
      const body = event.label === "door-code" || typeof event.body !== "string" ? undefined : redactDigitRuns(redact(event.body)).trim().slice(0, MAX_BODY);
      return {
        type: "message",
        id: event.id,
        at: event.at,
        direction: event.direction,
        role: event.role,
        ...(typeof event.personKey === "string" && /^[a-f0-9]{1,32}$/.test(event.personKey) ? { personKey: event.personKey } : {}),
        ...(isId(event.visit) ? { visit: event.visit } : {}),
        label: event.label,
        ...(body ? { body } : {}),
      };
    }
    case "visit-window": {
      if (!isId(event.visit) || !isTime(event.from) || !isTime(event.until) || !isTime(event.expectedAt)) return undefined;
      if (event.kind !== "cleaning" && event.kind !== "repair" && event.kind !== "crew-day") return undefined;
      if (Date.parse(event.until) <= Date.parse(event.from)) return undefined;
      if (event.checkIn !== undefined && !isTime(event.checkIn)) return undefined;
      const who = event.who;
      if (!who || (who.role !== "cleaner" && who.role !== "pro") || typeof who.name !== "string") return undefined;
      return {
        type: "visit-window",
        id: event.id,
        at: event.at,
        visit: event.visit,
        kind: event.kind,
        from: event.from,
        until: event.until,
        expectedAt: event.expectedAt,
        sameDay: Boolean(event.sameDay),
        ...(event.checkIn ? { checkIn: event.checkIn } : {}),
        who: { role: who.role, name: cleanName(who.name) || (who.role === "cleaner" ? "The cleaner" : "The pro"), ...(isId(who.proId) ? { proId: who.proId } : {}) },
      };
    }
    case "camera": {
      if (typeof event.device !== "string" || !event.device.trim()) return undefined;
      if (!["motion", "ding", "online", "offline"].includes(event.kind) || !isDeviceId(event.deviceId) || event.provider !== "ring") return undefined;
      const label = typeof event.label === "string" && event.label.trim() ? cleanName(event.label) : undefined;
      const media = (ref: unknown): MediaRef | undefined => {
        if (!ref || typeof ref !== "object") return undefined;
        const r = ref as Partial<MediaRef>;
        if (typeof r.device !== "string" || !r.device.trim() || typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined;
        const duration = typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : undefined;
        return { device: cleanName(r.device), at: r.at, ...(duration !== undefined ? { durationMs: duration } : {}) };
      };
      const snapshot = media(event.snapshot);
      const clip = media(event.clip);
      return {
        type: "camera",
        id: event.id,
        at: event.at,
        kind: event.kind,
        deviceId: event.deviceId,
        provider: "ring",
        device: cleanName(event.device),
        ...(label ? { label } : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(clip ? { clip } : {}),
      };
    }
    case "camera-count": {
      const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000;
      if (!isId(event.event) || typeof event.counter !== "string" || !/^[a-z0-9.-]{1,40}$/.test(event.counter)) return undefined;
      if (!count(event.people) || !count(event.vehicles) || !count(event.animals)) return undefined;
      if (event.confidence !== undefined && event.confidence !== "low") return undefined;
      return { type: "camera-count", id: event.id, at: event.at, event: event.event, counter: event.counter, people: event.people, vehicles: event.vehicles, animals: event.animals, ...(event.confidence ? { confidence: "low" as const } : {}) };
    }
    case "camera-pin": {
      if (!isDeviceId(event.deviceId) || !isTime(event.from) || !isTime(event.until) || Date.parse(event.until) <= Date.parse(event.from)) return undefined;
      if (event.event !== undefined && !isId(event.event)) return undefined;
      // A relative path inside the evidence folder: no leading slash, no "..", no backslash.
      if (typeof event.file !== "string" || !/^[A-Za-z0-9_\-][A-Za-z0-9_.\-/]{0,199}$/.test(event.file) || event.file.split("/").some((part) => part === ".." || part === "")) return undefined;
      return { type: "camera-pin", id: event.id, at: event.at, ...(event.event ? { event: event.event } : {}), deviceId: event.deviceId, from: event.from, until: event.until, file: event.file };
    }
    case "lock-status": {
      if (!["code-set", "code-failed", "battery", "offline", "online", "pool-low"].includes(event.kind)) return undefined;
      if (typeof event.device !== "string" || !event.device.trim()) return undefined;
      if (event.battery !== undefined && !(typeof event.battery === "number" && Number.isFinite(event.battery) && event.battery >= 0 && event.battery <= 100)) return undefined;
      const codeName = typeof event.codeName === "string" && event.codeName.trim() ? cleanName(event.codeName) : undefined;
      return { type: "lock-status", id: event.id, at: event.at, kind: event.kind, device: cleanName(event.device), ...(codeName ? { codeName } : {}), ...(event.battery !== undefined ? { battery: event.battery } : {}) };
    }
    case "service-notice":
      if (!isId(event.visit) || typeof event.notice !== "string" || !/^[a-f0-9]{8,64}$/.test(event.notice)) return undefined;
      if (event.serviceDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(event.serviceDate)) return undefined;
      return { type: "service-notice", id: event.id, at: event.at, visit: event.visit, notice: event.notice, ...(event.serviceDate ? { serviceDate: event.serviceDate } : {}) };
    case "visit-cancelled":
      return isId(event.visit) ? { type: "visit-cancelled", id: event.id, at: event.at, visit: event.visit } : undefined;
    case "visit-page":
      return isId(event.visit) && (event.step === "at-door" || event.step === "done") ? { type: "visit-page", id: event.id, at: event.at, visit: event.visit, step: event.step } : undefined;
    default:
      return undefined;
  }
}

export interface LogHealth {
  lines: number;
  skipped: number;
  lastLockAt?: string;
}

interface Loaded {
  signature: string;
  events: StoredEvent[];
  ids: Set<string>;
  skipped: number;
}

/** Read once per change of the files, per folder. */
const loaded = new Map<string, Loaded>();

/** Forgets what was read, as a restart would. Tests use it. */
export function resetVisitLogCache(): void {
  loaded.clear();
}

/** One property's visit log. */
export class VisitLog {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dir(): string {
    return join(this.root, VISIT_EVENTS_DIR);
  }

  private files(): string[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort();
  }

  private signature(files: readonly string[]): string {
    return files.map((name) => `${name}:${statSync(join(this.dir(), name)).size}`).join("|");
  }

  private load(): Loaded {
    const files = this.files();
    const signature = this.signature(files);
    const cached = loaded.get(this.root);
    if (cached && cached.signature === signature) return cached;
    const events: StoredEvent[] = [];
    const ids = new Set<string>();
    let skipped = 0;
    for (const name of files) {
      for (const line of readFileSync(join(this.dir(), name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as StoredEvent;
          const clean = cleanEvent(raw);
          if (!clean || !isTime(raw.loggedAt)) {
            skipped += 1;
            continue;
          }
          if (ids.has(clean.id)) continue;
          ids.add(clean.id);
          events.push({ ...clean, loggedAt: raw.loggedAt });
        } catch {
          skipped += 1;
        }
      }
    }
    const fresh = { signature, events, ids, skipped };
    loaded.set(this.root, fresh);
    return fresh;
  }

  /** Every event, in the order written. */
  read(): StoredEvent[] {
    return [...this.load().events];
  }

  /**
   * Writes one event, once. Gives back false when it was already there or can't be written. `redact` is the
   * caller's own redaction (Cleaner Core takes its door code out) and runs before the digit-run rule.
   */
  append(event: VisitEvent, redact?: (text: string) => string): boolean {
    const clean = cleanEvent(event, redact);
    if (!clean) return false;
    const state = this.load();
    if (state.ids.has(clean.id)) return false;
    const loggedAt = this.now().toISOString();
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const file = join(this.dir(), `${loggedAt.slice(0, 7)}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ ...clean, loggedAt })}\n`, { encoding: "utf8", mode: 0o600 });
    // Kept in step without a second read.
    state.ids.add(clean.id);
    state.events.push({ ...clean, loggedAt });
    state.signature = this.signature(this.files());
    return true;
  }

  health(): LogHealth {
    const state = this.load();
    const locks = state.events.filter((event) => event.type === "lock").map((event) => event.at);
    const lastLockAt = locks.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    return { lines: state.events.length, skipped: state.skipped, ...(lastLockAt ? { lastLockAt } : {}) };
  }

  /** A short hash of a phone, keyed with this property's own salt, so the key can't be worked back to the phone. */
  personKey(phone: string): string {
    return createHmac("sha256", this.salt()).update(phone).digest("hex").slice(0, 16);
  }

  private salt(): Buffer {
    const file = join(this.dir(), SALT_FILE);
    if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const salt = randomBytes(32);
    writeFileSync(file, salt.toString("hex"), { mode: 0o600, flag: "wx" });
    return salt;
  }

  /** The lock's names for codes and whose each one is. An unreadable file is none. */
  codeNames(): CodeNames {
    const file = join(this.root, VISIT_CODES_FILE);
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { codes?: unknown };
      const codes = raw.codes && typeof raw.codes === "object" && !Array.isArray(raw.codes) ? (raw.codes as Record<string, unknown>) : {};
      const out: CodeNames = {};
      for (const [name, person] of Object.entries(codes)) {
        const valid = validPerson(person);
        if (valid) out[name] = valid;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Saves whose a lock code is, by the lock's name for it. The name never holds digits. */
  nameCode(codeName: string, person: CodePerson | null): CodeNames {
    const name = cleanName(codeName);
    const codes = this.codeNames();
    for (const key of Object.keys(codes)) if (codeKey(key) === codeKey(name)) delete codes[key];
    if (person) codes[name] = person;
    writeFileSync(join(this.root, VISIT_CODES_FILE), `${JSON.stringify({ codes }, null, 2)}\n`, { mode: 0o600 });
    return codes;
  }
}

function validPerson(value: unknown): CodePerson | undefined {
  if (!value || typeof value !== "object") return undefined;
  const person = value as { role?: unknown; proId?: unknown };
  if (person.role === "pro") return isId(person.proId) ? { role: "pro", proId: person.proId } : undefined;
  if (person.role === "cleaner" || person.role === "host" || person.role === "guest" || person.role === "shared" || person.role === "package" || person.role === "visitor") return { role: person.role };
  return undefined;
}

/** The property folder's visit log. */
export function visitLogFor(root: string, now?: () => Date): VisitLog {
  return new VisitLog(root, now);
}
