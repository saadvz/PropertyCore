import type { VisitEvent } from "../visits/events";
import { visitLogFor } from "../visits/store";
import type { EventLog, StoredLine } from "./lines";

/**
 * The property's shared event log (#237's `visit-events/<YYYY-MM>.jsonl`) as the camera code sees it. Camera lines
 * are written under CAMERAS, whatever VISIT_RECORDS says: the store itself checks no flag (Saad, 19 Nov).
 */
export function sharedCameraLog(root: string, now?: () => Date): EventLog {
  const log = visitLogFor(root, now);
  return {
    append: (line) => log.append(line as unknown as VisitEvent),
    read: () => log.read() as unknown as StoredLine[],
  };
}
