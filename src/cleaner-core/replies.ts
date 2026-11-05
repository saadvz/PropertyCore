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
