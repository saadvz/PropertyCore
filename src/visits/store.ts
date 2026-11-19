import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeNames, CodePerson, StoredEvent, VisitEvent } from "./events";
import { codeKey } from "./events";

/**
 * The append-only log behind visit records (#237): `visit-events/<YYYY-MM>.jsonl` in the property's folder, one
 * file per month written. A line is written once and never edited or removed. A line that won't parse is skipped and
 * counted, never repaired. An id already in the log is not written again, so a resent webhook or a replay adds
 * nothing. No line holds a door code, a run of 4 or more digits, or a phone number.
 */

export const VISIT_EVENTS_DIR = "visit-events";
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
  if (person.role === "cleaner" || person.role === "host" || person.role === "guest" || person.role === "shared") return { role: person.role };
  return undefined;
}

/** The property folder's visit log. */
export function visitLogFor(root: string, now?: () => Date): VisitLog {
  return new VisitLog(root, now);
}
