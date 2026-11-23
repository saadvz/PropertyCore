import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "./wiringProof";

/** One text in a Scratch property's outbox, as read_outbox lists it. The door code shows as [redacted]. */
export interface OutboxText {
  label: string;
  status: string;
  body: string;
}

/**
 * A Scratch property's texts stay in its outbox and never reach Twilio, so tests read what went out from
 * read_outbox instead of from the fake Twilio client.
 */
export function outboxTexts(result: ToolResult): OutboxText[] {
  const texts = result.structured?.texts;
  if (!Array.isArray(texts)) throw new Error(result.text);
  return texts as OutboxText[];
}

/**
 * The texts in `after` that were not already in `before`, in the order `after` lists them. A line keeps its place
 * when its status changes, so a line that moved to a new status counts as new too.
 */
export function newTexts(before: OutboxText[], after: OutboxText[]): OutboxText[] {
  const key = (item: OutboxText) => `${item.label}\n${item.status}\n${item.body}`;
  const left = before.map(key);
  const added: OutboxText[] = [];
  for (const item of after) {
    const at = left.indexOf(key(item));
    if (at >= 0) left.splice(at, 1);
    else added.push(item);
  }
  return added;
}

/** "Hold note to the host" is to the host. */
export function isTo(item: OutboxText, role: "host" | "cleaner" | "observer" | "group"): boolean {
  return item.label.endsWith(` to the ${role}`);
}

/**
 * How many times the door code went out, from the saved Cleaner Core transcript under `root`. The outbox keeps one
 * line for a door code that is sent again, and the transcript keeps one line per send, with the code hidden.
 */
export function codeSends(root: string): number {
  const saved = JSON.parse(readFileSync(join(root, "cleaner-job", "cleaner-core.json"), "utf8")) as { transcript?: unknown };
  if (!Array.isArray(saved.transcript)) throw new Error("no saved transcript");
  return saved.transcript.filter((line) => typeof line === "string" && line.includes("Door code: [redacted]")).length;
}
