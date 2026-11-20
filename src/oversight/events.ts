/**
 * A lock entry in a shape no lock partner owns (#240), mapped from the visit log's unlocks by `entryEventsFrom`.
 * It never carries code digits. The check reads only `at`, `person` and `party`.
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
  /** The host's own code or a guest's: someone else, never the expected visitor. Set with no `person`. */
  party?: "host" | "guest";
}
