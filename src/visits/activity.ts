import { codeKey, codePerson, type CodeNames, type EntryNames, type VisitEvent } from "./events";
import { clockText } from "./wording";

/**
 * Who came in (#280 item 20): every unlock and lock at the property's doors, read from the visit log's lock lines,
 * with whose code it was or how the door was opened without one. A pure read: it never writes, sends, or holds a
 * code's digits. The lock partner's own words for how a door was worked are mapped to plain ones here.
 */

export interface ActivityEntry {
  at: string;
  door: string;
  action: "unlock" | "lock";
  /** The code's person by name, when the code is Property Core's or named by the host. */
  who?: string;
  /** The host's own code or a guest's. */
  party?: "host" | "guest";
  /** True with a code named here; "unknown-code" with a keypad code nobody named; false without a code. */
  withCode: boolean | "unknown-code";
  /** How a door was opened without a code, in plain words. */
  how?: string;
}

const HOW: Record<string, string> = {
  remote: "from the app",
  mobile_key: "from the app",
  manual: "by hand or with a key",
  automatic: "on its own",
  card: "with a card",
};

/** The lock lines between `span.from` (inclusive) and `span.until` (exclusive), oldest first, named. */
export function doorActivity(events: readonly VisitEvent[], codeNames: CodeNames, names: EntryNames, span: { from: number; until: number }): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const event of events) {
    if (event.type !== "lock") continue;
    const at = Date.parse(event.at);
    if (!(at >= span.from && at < span.until)) continue;
    const entry: ActivityEntry = { at: event.at, door: event.device, action: event.action, withCode: false };
    if (event.action === "unlock") {
      const person = codePerson(codeNames, event.codeName);
      if (person) {
        entry.withCode = true;
        if (person.role === "host" || person.role === "guest") entry.party = person.role;
        else {
          const name =
            person.role === "cleaner"
              ? (names.cleaner ?? "the cleaner")
              : person.role === "pro"
                ? names.pros?.[person.proId]
                : event.codeName
                  ? names.codes?.[codeKey(event.codeName)]
                  : undefined;
          if (name) entry.who = name;
        }
      } else if (event.codeName || event.method === "keycode") {
        entry.withCode = "unknown-code";
      } else {
        const how = event.method ? HOW[event.method] : undefined;
        if (how) entry.how = how;
      }
    }
    out.push(entry);
  }
  return mergeEchoes(out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}

/** Two reports of one turn of the lock land this close together. */
const ECHO_MS = 90_000;

/**
 * The lock partner can report one unlock twice, under two event ids (23 Nov Grok run). The same door doing the same
 * thing the same way within 90 seconds is told once.
 */
function mergeEchoes(sorted: ActivityEntry[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const entry of sorted) {
    const last = out.at(-1);
    const same =
      last &&
      last.door === entry.door &&
      last.action === entry.action &&
      last.withCode === entry.withCode &&
      last.who === entry.who &&
      last.how === entry.how &&
      last.party === entry.party &&
      Date.parse(entry.at) - Date.parse(last.at) <= ECHO_MS;
    if (!same) out.push(entry);
  }
  return out;
}

/** One plain sentence, like "The Front door was unlocked at 1:13 AM, without a code (from the app)." */
export function activitySentence(entry: ActivityEntry, timeZone: string): string {
  const head = `The ${entry.door} was ${entry.action === "unlock" ? "unlocked" : "locked"} at ${clockText(entry.at, timeZone)}`;
  if (entry.action === "lock") return `${head}.`;
  if (entry.party === "host") return `${head} with your own code.`;
  if (entry.party === "guest") return `${head} with the guest's code.`;
  if (entry.withCode === true) return entry.who ? `${head} with ${entry.who}'s code.` : `${head} with a code Property Core made.`;
  if (entry.withCode === "unknown-code") return `${head} with a code that isn't one of Property Core's.`;
  return entry.how ? `${head}, without a code (${entry.how}).` : `${head}, without a code.`;
}
