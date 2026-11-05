/**
 * Which kept messages the host has answered, and what the assistant reads before the new ones.
 * Pure: it reads the kept message list (oldest first) and sends nothing.
 */

/** The fields of a kept message these rules read. LiveDesk's Message fits it. */
export interface ThreadMessage {
  id: string;
  from: "cleaner" | "host" | "contact";
  name: string;
  /** Who a host message the assistant sent went to, like Ana or "the group". */
  to?: string;
  channel?: "group";
  handled: string;
}

export type ReplyState = { reply: "open" } | { reply: "answered"; by: "group" | "assistant" };

/** Who a host message sent through the assistant to the group is kept as going to. */
export const GROUP_RECIPIENT = "the group";

/**
 * A cleaner or contact message is answered by the first later host message that reached them:
 * the host's own group text, or an assistant send to the group or to that person. Host messages
 * have no reply state.
 */
export function replyStateAt(messages: readonly ThreadMessage[], index: number): ReplyState | undefined {
  const message = messages[index];
  if (!message || message.from === "host") return undefined;
  for (const later of messages.slice(index + 1)) {
    if (later.from !== "host") continue;
    if (later.channel === "group") return { reply: "answered", by: "group" };
    if (later.handled === "sent" && (later.to === GROUP_RECIPIENT || later.to === message.name)) return { reply: "answered", by: "assistant" };
  }
  return { reply: "open" };
}

/** Up to `max` messages just before `firstNew`, oldest first. */
export function earlierThan<T>(messages: readonly T[], firstNew: number, max = 6): T[] {
  return messages.slice(Math.max(0, firstNew - max), Math.max(0, firstNew));
}

/** A reply the assistant saved for the host to send. It sends nothing by itself. */
export interface StoredDraft {
  id: string;
  /** The cleaner or contact message it answers. */
  replyTo: string;
  /** What recipientOf takes: "group", or the name of the person who wrote. */
  to: string;
  text: string;
  /** The newest kept message when it was saved. */
  base: string;
}

export type DraftStatus = "ready" | "stale" | "answered" | "gone";

/**
 * gone: its message or base is no longer kept. answered: the host has replied to its message.
 * stale: something came in after it was saved. A send through the assistant isn't new to read,
 * so it leaves a draft ready.
 */
export function draftStatus(draft: StoredDraft, messages: readonly ThreadMessage[]): DraftStatus {
  const at = messages.findIndex((message) => message.id === draft.replyTo);
  const base = messages.findIndex((message) => message.id === draft.base);
  if (at < 0 || base < 0) return "gone";
  if (replyStateAt(messages, at)?.reply === "answered") return "answered";
  const newer = messages.slice(base + 1).some((message) => !(message.from === "host" && message.handled === "sent"));
  return newer ? "stale" : "ready";
}
