/**
 * A lock entry in a shape no lock partner owns (#240). The lock connection (#180) fills it later; for now the
 * same-day check runs on sample events. It never carries code digits. The check reads only `at` and `person`.
 */

export interface EntryEvent {
  id: string;
  /** ISO time. */
  at: string;
  /** The lock's name, like "Front door". */
  device: string;
  /** Whose code, as the lock partner names it. Unset when the code isn't named. */
  person?: string;
  /** The provider's word as given, like "keypad", "app" or "key". The check never reads it. */
  method?: string;
}

/** The stored lock lines #180 writes, as #240's entries: each unlock, named by whose Property Core code opened it. */
export function entryEventsFrom(lines: readonly { type: string; id: string; at: string; action?: string; device?: string; method?: string; grant?: { flow: string; jobId: string } }[], names: (grant: { flow: string; jobId: string }) => string | undefined = () => undefined): EntryEvent[] {
  return lines
    .filter((line) => line.type === "lock" && line.action === "unlock")
    .map((line) => {
      const person = line.grant ? names(line.grant) : undefined;
      return { id: line.id, at: line.at, device: line.device ?? "a door", ...(person ? { person } : {}), ...(line.method ? { method: line.method } : {}) };
    });
}
