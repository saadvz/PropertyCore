import { formatWhen } from "../hub/calendar";
import type { PickedCamera } from "./accounts";
import { isCameraEvent, type StoredLine } from "./lines";

/**
 * Camera offline notes (#239). A picked camera offline for 30 minutes gets one note to the host, and one more
 * when it's back. A camera back within 30 minutes gets none. Each note has an id, so it is told once across
 * replays and restarts.
 */

export const OFFLINE_WAIT_MS = 30 * 60_000;

export interface CameraNote {
  id: string;
  text: string;
}

export function dueCameraNotes(lines: readonly StoredLine[], cameras: readonly PickedCamera[], now: Date, opts: { label: string; timeZone?: string; told: readonly string[] }): CameraNote[] {
  const told = new Set(opts.told);
  const notes: CameraNote[] = [];
  for (const camera of cameras) {
    const changes = lines.filter(isCameraEvent).filter((line) => line.deviceId === camera.deviceId && (line.kind === "offline" || line.kind === "online"));
    changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let offline: (typeof changes)[number] | undefined;
    for (const change of changes) {
      if (change.kind === "offline") {
        offline ??= change;
        continue;
      }
      // Back online: a note only when the offline one went out.
      if (offline && told.has(`camera-offline:${offline.id}`) && !told.has(`camera-online:${change.id}`)) notes.push({ id: `camera-online:${change.id}`, text: `The ${camera.name} camera at ${opts.label} is back online.` });
      offline = undefined;
    }
    if (offline && now.getTime() - Date.parse(offline.at) >= OFFLINE_WAIT_MS && !told.has(`camera-offline:${offline.id}`)) {
      const since = opts.timeZone ? formatWhen(offline.at, opts.timeZone).time : new Date(offline.at).toISOString().slice(11, 16) + " UTC";
      notes.push({ id: `camera-offline:${offline.id}`, text: `The ${camera.name} camera at ${opts.label} has been offline since ${since}. Check its power and Wi-Fi.` });
    }
  }
  return notes;
}
