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
  /** Who an assistant send reached: "group", "cleaner", or "contact:<name>". Older rows have only `to`. */
  target?: string;
  channel?: "group";
  handled: string;
}

export type ReplyState = { reply: "open" } | { reply: "answered"; by: "group" | "assistant" };

/** Who a host message sent through the assistant to the group is kept as going to. */
export const GROUP_RECIPIENT = "the group";

/**
 * A cleaner or contact message is answered by the first later host message that reached them: the
 * host's own group text or an assistant send to the group, when the message came in the group or is
 * the cleaner's (she is always in it); or an assistant send to that same person. A contact's
 * one-to-one text isn't answered by the group, since the group may not hold them. Host messages
 * have no reply state.
 */
export function replyStateAt(messages: readonly ThreadMessage[], index: number): ReplyState | undefined {
  const message = messages[index];
  if (!message || message.from === "host") return undefined;
  const groupReaches = message.channel === "group" || message.from === "cleaner";
  const self = message.from === "cleaner" ? "cleaner" : `contact:${message.name}`;
  for (const later of messages.slice(index + 1)) {
    if (later.from !== "host") continue;
    if (later.channel === "group") {
      if (groupReaches) return { reply: "answered", by: "group" };
      continue;
    }
    if (later.handled !== "sent") continue;
    const target = later.target ?? (later.to === GROUP_RECIPIENT ? "group" : undefined);
    if (target === "group" ? groupReaches : target ? target === self : later.to === message.name) return { reply: "answered", by: "assistant" };
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
  /** Who it goes to: "group", "cleaner:<phone>", or "contact:<phone>". Never shown; check_now shows a name. */
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
