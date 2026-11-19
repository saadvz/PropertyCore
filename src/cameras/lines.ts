/**
 * Camera lines in the property's shared event log (#239, written through #237's visit log). A camera line is the
 * provider's event as received; a count line is our own count for one event, written later; a pin line records a
 * clip the host kept as evidence. Lines are written once and never edited: a recount is a new count line. No line
 * holds an image, a video, a link or a token.
 */

export type CameraKind = "motion" | "ding" | "online" | "offline";
export const CAMERA_KINDS: readonly CameraKind[] = ["motion", "ding", "online", "offline"];

export interface CameraEventLine {
  type: "camera";
  /** The provider's own event id, so a resent webhook is stored once. */
  id: string;
  /** ISO time the provider says it happened. */
  at: string;
  /** The host's name for the camera, like "Front door". */
  device: string;
  /** The provider's id for the camera. */
  deviceId: string;
  provider: string;
  kind: CameraKind;
  /** The provider's label as given, like "human", "vehicle", "package_delivery", "other_motion" or "motion". */
  label?: string;
}

export interface CameraCountLine {
  type: "camera-count";
  /** "count:<eventId>:<counter>". */
  id: string;
  /** The camera event's time. */
  at: string;
  /** The camera event's id. */
  event: string;
  /** The counter and its version, like "vision-v1". */
  counter: string;
  people: number;
  vehicles: number;
  animals: number;
  confidence?: "low";
}

export interface CameraPinLine {
  type: "camera-pin";
  id: string;
  /** When the host pinned it. */
  at: string;
  /** The camera event it came from, when it came from one. */
  event?: string;
  deviceId: string;
  from: string;
  until: string;
  /** Where the copy is, under the property's evidence/ folder. */
  file: string;
}

export type CameraLine = CameraEventLine | CameraCountLine | CameraPinLine;
export type StoredLine = { type: string; id: string; at: string; loggedAt?: string } & Record<string, unknown>;

/**
 * The shared event log as the camera code sees it. #237's `VisitLog` satisfies it; tests use `memoryLog`.
 * `append` returns false for an id already written or a line that doesn't check.
 */
export interface EventLog {
  append(line: CameraLine): boolean;
  read(): StoredLine[];
}

const MAX_ID = 200;
const MAX_NAME = 80;
const MAX_COUNT = 1000;

/** Every run of 4 or more digits, even split by spaces, dots, dashes, underscores or slashes. Cleaner Core's rule. */
export function redactDigitRuns(text: string): string {
  return text.replace(/\d(?:[\s.\-_/‐-―]*\d){3,}/g, "[redacted]");
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const name = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? redactDigitRuns(value).trim().slice(0, MAX_NAME) : undefined);
const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const EVIDENCE_FILE = /^evidence\/[A-Za-z0-9._-]{1,120}$/;

/** The line as it may be written: checked, with only its own fields, names cleaned. Undefined when it can't be written. */
export function cleanCameraLine(line: CameraLine): CameraLine | undefined {
  if (!line || typeof line !== "object" || !isId(line.id) || !isTime(line.at)) return undefined;
  switch (line.type) {
    case "camera": {
      const device = name(line.device);
      if (!device || !isId(line.deviceId) || !isId(line.provider) || !CAMERA_KINDS.includes(line.kind)) return undefined;
      const label = name(line.label);
      return { type: "camera", id: line.id, at: line.at, device, deviceId: line.deviceId, provider: line.provider, kind: line.kind, ...(label ? { label } : {}) };
    }
    case "camera-count": {
      if (!isId(line.event) || !isId(line.counter) || !whole(line.people) || !whole(line.vehicles) || !whole(line.animals)) return undefined;
      return {
        type: "camera-count",
        id: line.id,
        at: line.at,
        event: line.event,
        counter: line.counter,
        people: line.people,
        vehicles: line.vehicles,
        animals: line.animals,
        ...(line.confidence === "low" ? { confidence: "low" as const } : {}),
      };
    }
    case "camera-pin": {
      if (!isId(line.deviceId) || !isTime(line.from) || !isTime(line.until) || Date.parse(line.until) <= Date.parse(line.from)) return undefined;
      if (typeof line.file !== "string" || !EVIDENCE_FILE.test(line.file)) return undefined;
      return { type: "camera-pin", id: line.id, at: line.at, ...(isId(line.event) ? { event: line.event } : {}), deviceId: line.deviceId, from: line.from, until: line.until, file: line.file };
    }
    default:
      return undefined;
  }
}

/** An in-memory log with the shared log's rules, for tests and the Scratch CLI. */
export function memoryLog(now: () => Date = () => new Date()): EventLog & { lines: StoredLine[] } {
  const lines: StoredLine[] = [];
  return {
    lines,
    append(line) {
      const clean = cleanCameraLine(line);
      if (!clean || lines.some((stored) => stored.id === clean.id)) return false;
      lines.push({ ...clean, loggedAt: now().toISOString() } as StoredLine);
      return true;
    },
    read: () => lines.map((line) => ({ ...line })),
  };
}

export const isCameraEvent = (line: StoredLine): line is StoredLine & CameraEventLine => line.type === "camera";
export const isCountLine = (line: StoredLine): line is StoredLine & CameraCountLine => line.type === "camera-count";
export const isPinLine = (line: StoredLine): line is StoredLine & CameraPinLine => line.type === "camera-pin";

/** Each event's count from the count line written last for it: a recount with a newer counter wins. */
export function latestCounts(lines: readonly StoredLine[]): Map<string, CameraCountLine> {
  const counts = new Map<string, CameraCountLine>();
  for (const line of lines) if (isCountLine(line)) counts.set(line.event, line);
  return counts;
}
