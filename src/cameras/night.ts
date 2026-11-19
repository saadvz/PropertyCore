import type { StayEvent } from "../stay-check/events";
import { countable } from "./count";
import { isCameraEvent, latestCounts, type StoredLine } from "./lines";

/**
 * Camera lines to the nightly check's provider-neutral events (#239). Counts come from the newest count line for
 * each event; an event with none has no counts and the check lists it as uncounted. Media is by reference only:
 * the snapshot at the event's time, and a clip from 30 seconds before to 60 seconds after.
 */

export const CLIP_BEFORE_MS = 30_000;
export const CLIP_AFTER_MS = 60_000;

export function stayEventsFrom(lines: readonly StoredLine[], window: { from: string; to: string }): StayEvent[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const counts = latestCounts(lines);
  return lines
    .filter(isCameraEvent)
    .filter((line) => countable(line))
    .filter((line) => {
      const at = Date.parse(line.at);
      return at >= from && at < to;
    })
    .map((line) => {
      const at = Date.parse(line.at);
      const count = counts.get(line.id);
      return {
        id: line.id,
        at: line.at,
        source: "camera" as const,
        device: line.device,
        ...(line.label ? { label: line.label } : {}),
        ...(count ? { counts: { people: count.people, vehicles: count.vehicles, animals: count.animals } } : {}),
        snapshot: { device: line.device, at },
        clip: { device: line.device, at: at - CLIP_BEFORE_MS, durationMs: CLIP_BEFORE_MS + CLIP_AFTER_MS },
      };
    });
}
