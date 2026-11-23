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

/** The texts in `after` that were not already in `before`, matched by label and body, in the order `after` lists them. */
export function newTexts(before: OutboxText[], after: OutboxText[]): OutboxText[] {
  const left = before.map((item) => `${item.label}\n${item.body}`);
  const added: OutboxText[] = [];
  for (const item of after) {
    const at = left.indexOf(`${item.label}\n${item.body}`);
    if (at >= 0) left.splice(at, 1);
    else added.push(item);
  }
  return added;
}

/** "Hold note to the host" is to the host. */
export function isTo(item: OutboxText, role: "host" | "cleaner" | "observer" | "group"): boolean {
  return item.label.endsWith(` to the ${role}`);
}
