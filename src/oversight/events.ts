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
