import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToParent, ToWorker } from "../hosted/ipc";

/**
 * What Tour Core tells an operator notification channel (Operator Updates).
 * Deliberately minimal: what kind of update, which property, which tour or
 * issue, when. No visitor names, numbers or message text, and no
 * credentials. The receiver (a Grok Routine today) wakes up and reads the
 * canonical details over MCP (`get_inbox`), so Tour Core stays the
 * system of record.
 */

/** Tour lifecycle updates: what the landlord may want to hear about as it happens. */
export const TOUR_EVENT_TYPES = ["tour.booked", "tour.started", "tour.completed", "tour.cancelled"] as const;
/** Something that needs the landlord's judgment. Each points at one open issue. */
export const ISSUE_EVENT_TYPES = ["exception.created", "access.problem", "verification.problem"] as const;
/** A visitor asked for a time that needs the landlord. Not optional: a person has to decide. */
export const TIME_REQUEST_EVENT = "tour.time_requested" as const;
export const OPERATOR_EVENT_TYPES = [...TOUR_EVENT_TYPES, ...ISSUE_EVENT_TYPES, TIME_REQUEST_EVENT, "installation.test", "cleaning.update"] as const;
export type OperatorEventType = (typeof OPERATOR_EVENT_TYPES)[number];
export type TourEventType = (typeof TOUR_EVENT_TYPES)[number];
export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];

export const OperatorEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,80}$/),
  eventType: z.enum(OPERATOR_EVENT_TYPES),
  propertyId: z.string().regex(/^[a-z0-9_]+$/).optional(),
  /** The tour's handle (get_tours tourRef). A date-and-channel label; never a name or number. */
  tourId: z.string().regex(/^[a-z0-9_]+~[A-Za-z0-9_-]+$/).optional(),
  exceptionId: z.string().regex(/^exc_[a-f0-9]{12}$/).optional(),
  tourTimeRequestId: z.string().regex(/^ttr_[a-f0-9]{12}$/).optional(),
  occurredAt: z.string(),
});
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;

export const isTourEvent = (t: OperatorEventType): t is TourEventType => (TOUR_EVENT_TYPES as readonly string[]).includes(t);
export const isIssueEvent = (t: OperatorEventType): t is IssueEventType => (ISSUE_EVENT_TYPES as readonly string[]).includes(t);

/**
 * The same issue always gets the same eventId, across retries, restarts and
 * event types (an issue announced before issue types existed isn't announced again).
 */
export const exceptionEventId = (exceptionId: string) => `evt_${createHash("sha256").update(`exception.created|${exceptionId}`).digest("hex").slice(0, 24)}`;

/** One update per tour step per reservation: a repeated message or rescan never announces it twice. */
export const tourEventId = (eventType: TourEventType, tourRef: string, reservationId: string) =>
  `evt_${createHash("sha256").update(`${eventType}|${tourRef}|${reservationId}`).digest("hex").slice(0, 24)}`;

export function exceptionCreatedEvent(input: { propertyId: string; exceptionId: string; occurredAt: string; eventType?: IssueEventType }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: exceptionEventId(input.exceptionId),
    eventType: input.eventType ?? "exception.created",
    propertyId: input.propertyId,
    exceptionId: input.exceptionId,
    occurredAt: input.occurredAt,
  });
}

export function tourEvent(input: { eventType: TourEventType; propertyId: string; tourRef: string; reservationId: string; occurredAt: string }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: tourEventId(input.eventType, input.tourRef, input.reservationId),
    eventType: input.eventType,
    propertyId: input.propertyId,
    tourId: input.tourRef,
    occurredAt: input.occurredAt,
  });
}

export const timeRequestEventId = (tourTimeRequestId: string) =>
  `evt_${createHash("sha256").update(`tour.time_requested|${tourTimeRequestId}`).digest("hex").slice(0, 24)}`;

/** Minimal on purpose: no visitor name, number, unit or message. Grok reads the request over MCP. */
export function timeRequestedEvent(input: { propertyId: string; tourTimeRequestId: string; occurredAt: string }): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: timeRequestEventId(input.tourTimeRequestId),
    eventType: "tour.time_requested",
    propertyId: input.propertyId,
    tourTimeRequestId: input.tourTimeRequestId,
    occurredAt: input.occurredAt,
  });
}

export function testEvent(now: Date): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: `evt_test_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    eventType: "installation.test",
    occurredAt: now.toISOString(),
  });
}

/**
 * Cleaner Core has a new host alert. It carries no property, job, name, number or text:
 * the cleaning routine wakes and reads the alerts over MCP (`check_now`).
 */
export function cleaningUpdateEvent(now: Date): OperatorEvent {
  return OperatorEventSchema.parse({
    schemaVersion: 1,
    eventId: `evt_${randomUUID().replace(/-/g, "")}`,
    eventType: "cleaning.update",
    occurredAt: now.toISOString(),
  });
}

/** A delivery that didn't go through. The message is plain and never contains the address or key. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface OperatorNotificationSink {
  readonly kind: "NONE" | "GROK_ROUTINE" | "CLAUDE_ROUTINE" | "CHATGPT_TASK";
  /** Whether this sink has what it needs to deliver. */
  configured(): boolean;
  /** Resolves once the receiver accepted the event; throws DeliveryError otherwise. */
  deliver(event: OperatorEvent): Promise<void>;
}

/** No channel set up: events wait in the outbox until one is. */
export class NoopOperatorNotificationSink implements OperatorNotificationSink {
  readonly kind = "NONE" as const;
  configured(): boolean {
    return false;
  }
  async deliver(): Promise<void> {
    throw new DeliveryError("Operator alerts aren't connected yet.", true);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Wakes a Grok Routine through its authenticated webhook: one JSON POST with
 * the routine's key as a bearer token. The address and key come from the
 * SecretStore on every delivery, so rotating them on the secure setup page
 * takes effect immediately.
 */
export class GrokRoutineWebhookSink implements OperatorNotificationSink {
  readonly kind = "GROK_ROUTINE" as const;

  constructor(
    private readonly settings: { url: () => string | undefined; key: () => string | undefined },
    private readonly options: { fetch?: Fetch; timeoutMs?: number } = {},
  ) {}

  configured(): boolean {
    return !!this.settings.url() && !!this.settings.key();
  }

  async deliver(event: OperatorEvent): Promise<void> {
    const url = this.settings.url();
    const key = this.settings.key();
    if (!url || !key) throw new DeliveryError("Operator alerts aren't connected yet.", true);
    const body = JSON.stringify(OperatorEventSchema.parse(event));
    const doFetch: Fetch = this.options.fetch ?? ((u, init) => fetch(u, init));
    let status: number;
    try {
      ({ status } = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": "tour-core" },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      }));
    } catch {
      throw new DeliveryError("Couldn't reach the Grok Routine right now.", true);
    }
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new DeliveryError("The Grok Routine refused the connection details. Re-enter them on the secure setup page.", true);
    if (status === 404) throw new DeliveryError("The Grok Routine address wasn't found. Check it on the secure setup page.", true);
    throw new DeliveryError(`The Grok Routine didn't accept the update (status ${status}).`, status >= 500 || status === 429);
  }
}

/**
 * A touring process on the shared service: each event goes to the service over IPC, and the service
 * delivers it through the tenant's routine. The process's own outbox keeps the event until the
 * service answers that it was delivered, so a crash or a refused wake is retried as usual.
 */
export class RelaySink implements OperatorNotificationSink {
  readonly kind = "GROK_ROUTINE" as const;
  private readonly waiting = new Map<string, { resolve: () => void; reject: (err: DeliveryError) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (message: ToParent) => void,
    private readonly connected: () => boolean,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  configured(): boolean {
    return this.connected();
  }

  deliver(event: OperatorEvent): Promise<void> {
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DeliveryError("The shared service didn't answer about this update.", true));
      }, this.options.timeoutMs ?? 30_000);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.send({ type: "event", id, event });
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new DeliveryError("The shared service can't be reached right now.", true));
      }
    });
  }

  /** The service's answer about one event. An answer for an event no longer waiting is ignored. */
  ack(message: Extract<ToWorker, { type: "event-ack" }>): void {
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    this.waiting.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve();
    else waiting.reject(new DeliveryError(message.message, message.retryable));
  }
}

/** The beta header Claude's routine fire endpoint ships under. */
export const CLAUDE_ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

/**
 * Wakes a Claude Code scheduled task through its API trigger: POST { text } to the task's Fire URL
 * with its bearer token. The text is the same minimal event a Grok Routine gets, as JSON, and the
 * task reads it only as data. Used only by a Cleaner Core deployment set to Claude.
 */
export class ClaudeRoutineFireSink implements OperatorNotificationSink {
  readonly kind = "CLAUDE_ROUTINE" as const;

  constructor(
    private readonly settings: { url: () => string | undefined; key: () => string | undefined },
    private readonly options: { fetch?: Fetch; timeoutMs?: number } = {},
  ) {}

  configured(): boolean {
    return !!this.settings.url() && !!this.settings.key();
  }

  async deliver(event: OperatorEvent): Promise<void> {
    const url = this.settings.url();
    const key = this.settings.key();
    if (!url || !key) throw new DeliveryError("Alerts aren't connected yet.", true);
    const body = JSON.stringify({ text: JSON.stringify(OperatorEventSchema.parse(event)) });
    const doFetch: Fetch = this.options.fetch ?? ((u, init) => fetch(u, init));
    let status: number;
    try {
      ({ status } = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": CLAUDE_ROUTINE_BETA,
          "User-Agent": "tour-core",
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      }));
    } catch {
      throw new DeliveryError("Couldn't reach the Claude scheduled task right now.", true);
    }
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new DeliveryError("The Claude scheduled task refused its token. Make a new token and save it again.", true);
    if (status === 404) throw new DeliveryError("The Claude scheduled task's Fire URL wasn't found. Check it and save it again.", true);
    throw new DeliveryError(`The Claude scheduled task didn't accept the update (status ${status}).`, status >= 500 || status === 429);
  }
}

/**
 * A ChatGPT scheduled task or a Muse recurring task can't be started from outside the chat, so there
 * is nothing to wake. Once the hourly task is connected, a wake-up counts as delivered: the task
 * reads every note and message with check_now on its next run. Used only by a Cleaner Core
 * deployment set to ChatGPT or Muse.
 */
export class ChatGptTaskSink implements OperatorNotificationSink {
  readonly kind = "CHATGPT_TASK" as const;

  constructor(private readonly connected: () => boolean) {}

  configured(): boolean {
    return this.connected();
  }

  async deliver(): Promise<void> {
    if (!this.connected()) throw new DeliveryError("Alerts aren't connected yet.", true);
  }
}
