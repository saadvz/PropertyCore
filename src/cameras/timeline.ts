import { dateFormat } from "../core/timezone";
import { formatWhen } from "../hub/calendar";
import { isCameraEvent, latestCounts, type StoredLine } from "./lines";

/**
 * A stay's timeline from the property's event log (#239): camera events with our counts, and lock events once the
 * lock connection (#180) writes them, oldest first, in the property's time. Ready to paste into a platform claim.
 * Pure: the same lines always give the same timeline.
 */

export interface TimelineEntry {
  id: string;
  at: string;
  source: "camera" | "lock";
  device: string;
  /** The camera's label or kind, or the lock's action. */
  what: string;
  counts?: { people: number; vehicles: number; animals: number };
  /** The lock's own name for the code used. */
  codeName?: string;
}

export function stayTimeline(lines: readonly StoredLine[], window: { from: string; to: string }, _timeZone: string, counter?: string): TimelineEntry[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const counts = latestCounts(lines, counter);
  const entries: TimelineEntry[] = [];
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!(at >= from && at < to)) continue;
    if (isCameraEvent(line)) {
      const count = counts.get(line.id);
      entries.push({ id: line.id, at: line.at, source: "camera", device: line.device, what: line.kind === "motion" ? (line.label ?? "motion") : line.kind, ...(count ? { counts: { people: count.people, vehicles: count.vehicles, animals: count.animals } } : {}) });
    } else if (line.type === "lock" && typeof line.device === "string" && (line.action === "unlock" || line.action === "lock")) {
      entries.push({ id: line.id, at: line.at, source: "lock", device: line.device, what: line.action, ...(typeof line.codeName === "string" ? { codeName: line.codeName } : {}) });
    }
  }
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(entry: TimelineEntry): string {
  if (entry.source === "lock") return `${entry.device} ${entry.what === "unlock" ? "unlocked" : "locked"}${entry.codeName ? ` (${entry.codeName})` : ""}`;
  const seen = entry.counts
    ? [entry.counts.people ? plural(entry.counts.people, "person").replace("persons", "people") : "", entry.counts.vehicles ? plural(entry.counts.vehicles, "vehicle") : "", entry.counts.animals ? plural(entry.counts.animals, "animal") : ""].filter(Boolean).join(", ") || "nothing counted"
    : "not counted";
  return `${entry.device} camera, ${entry.what.replace(/_/g, " ")}: ${seen}`;
}

export function timelineText(label: string, entries: readonly TimelineEntry[], timeZone: string): string {
  const day = dateFormat({ timeZone, weekday: "short", month: "short", day: "numeric" });
  const lines = entries.map((entry) => `${day.format(new Date(entry.at))}, ${formatWhen(entry.at, timeZone).time}: ${describe(entry)}`);
  return [`Stay timeline for ${label}`, ...(lines.length ? lines : ["No camera or lock events in this stay."])].join("\n");
}
