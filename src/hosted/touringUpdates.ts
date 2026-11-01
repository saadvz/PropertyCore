import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorEvent, OperatorEventType, OperatorNotificationSink } from "../alerts/operatorEvents";
import { tenantFolder } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * What's new for a touring host whose chat runs a recurring task that nothing can wake (ChatGPT, Muse).
 * The service keeps the tenant's recent tour events; each connection reads past its own marker with
 * get_updates, so one chat's task never marks another chat's updates read.
 */

const KEEP_MS = 7 * 24 * 60 * 60_000;
const KEEP_EVENTS = 200;

interface Entry {
  seq: number;
  eventId: string;
  eventType: OperatorEventType;
  occurredAt: string;
  addedAt: string;
}

interface Feed {
  next: number;
  events: Entry[];
  /** The last seq each connection read. */
  read: Record<string, number>;
  /** When each connection last called get_updates. */
  checked: Record<string, string>;
}

const LINES: Partial<Record<OperatorEventType, string>> = {
  "tour.time_requested": "A visitor asked for a tour time.",
  "exception.created": "Something on a tour needs you.",
  "access.problem": "Something on a tour needs you.",
  "verification.problem": "Something on a tour needs you.",
  "tour.booked": "A tour was booked.",
  "tour.started": "A tour was started.",
  "tour.completed": "A tour was finished.",
  "tour.cancelled": "A tour was cancelled.",
};

/** The plain line for an event, as get_updates says it. */
export function updateLine(eventType: OperatorEventType): string | undefined {
  return LINES[eventType];
}

const file = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "touring-updates.json");

function readFeed(h: HostedCleaner, tenantId: string): Feed {
  const empty: Feed = { next: 1, events: [], read: {}, checked: {} };
  const path = file(h, tenantId);
  if (!existsSync(path)) return empty;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<Feed>;
    return { next: doc.next ?? 1, events: doc.events ?? [], read: doc.read ?? {}, checked: doc.checked ?? {} };
  } catch {
    return empty;
  }
}

function writeFeed(h: HostedCleaner, tenantId: string, feed: Feed): void {
  const cutoff = h.now().getTime() - KEEP_MS;
  const events = feed.events.filter((e) => Date.parse(e.addedAt) > cutoff).slice(-KEEP_EVENTS);
  writeJsonAtomic(file(h, tenantId), { ...feed, events });
}

/** Adds an event the host should hear about, once. The setup test and anything without a line is skipped. */
export function appendUpdate(h: HostedCleaner, tenantId: string, event: OperatorEvent): void {
  if (!updateLine(event.eventType)) return;
  const feed = readFeed(h, tenantId);
  if (feed.events.some((e) => e.eventId === event.eventId)) return;
  feed.events.push({ seq: feed.next, eventId: event.eventId, eventType: event.eventType, occurredAt: event.occurredAt, addedAt: h.now().toISOString() });
  feed.next += 1;
  writeFeed(h, tenantId, feed);
}

/** This connection's unread events, oldest first, marked read. Notes when it checked. */
export function takeUpdates(h: HostedCleaner, tenantId: string, grantId: string): { eventType: OperatorEventType; occurredAt: string; line: string }[] {
  const feed = readFeed(h, tenantId);
  const since = feed.read[grantId] ?? 0;
  const unread = feed.events.filter((e) => e.seq > since);
  feed.read[grantId] = Math.max(since, ...unread.map((e) => e.seq));
  feed.checked[grantId] = h.now().toISOString();
  writeFeed(h, tenantId, feed);
  return unread.map((e) => ({ eventType: e.eventType, occurredAt: e.occurredAt, line: updateLine(e.eventType)! }));
}

/** When this connection last called get_updates, if ever. */
export function lastCheckAt(h: HostedCleaner, tenantId: string, grantId: string): string | undefined {
  return readFeed(h, tenantId).checked[grantId];
}

/** A recurring task's channel: an event is delivered once it's on the list, since nothing can wake the task. */
export class UpdateFeedSink implements OperatorNotificationSink {
  readonly kind = "CHATGPT_TASK" as const;

  constructor(
    private readonly h: HostedCleaner,
    private readonly tenantId: string,
  ) {}

  configured(): boolean {
    return true;
  }

  polled(): boolean {
    return true;
  }

  async deliver(event: OperatorEvent): Promise<void> {
    appendUpdate(this.h, this.tenantId, event);
  }
}
