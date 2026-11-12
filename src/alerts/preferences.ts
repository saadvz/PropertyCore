import type { OperatorEvent, OperatorEventType } from "./operatorEvents";

/**
 * Which operator updates the landlord wants. Stored with the installation
 * (not secret), provider-neutral, and never holding who or what a tour is
 * about. Normal texts and door requests are never updates on their own.
 */

export const UPDATE_KINDS = ["TOUR_BOOKED", "TOUR_STARTED", "TOUR_COMPLETED", "TOUR_CANCELLED", "EXCEPTION_CREATED", "ACCESS_PROBLEM", "VERIFICATION_PROBLEM"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];

/** Tour Core's P0 recommendation: the tour's big moments, plus anything that needs the landlord. */
export const RECOMMENDED_UPDATES: UpdateKind[] = ["TOUR_BOOKED", "TOUR_STARTED", "TOUR_COMPLETED", "EXCEPTION_CREATED", "ACCESS_PROBLEM", "VERIFICATION_PROBLEM"];
/** Only what needs the landlord's judgment. What an installation gets before it chose anything (alerts started as issues only). */
export const PROBLEMS_ONLY: UpdateKind[] = ["EXCEPTION_CREATED", "ACCESS_PROBLEM", "VERIFICATION_PROBLEM"];

export const UPDATE_LABELS: Record<UpdateKind, string> = {
  TOUR_BOOKED: "a tour is booked",
  TOUR_STARTED: "a tour starts",
  TOUR_COMPLETED: "a tour is finished",
  TOUR_CANCELLED: "a booked tour is cancelled",
  EXCEPTION_CREATED: "a visitor needs your input",
  ACCESS_PROBLEM: "a visitor has trouble with a door",
  VERIFICATION_PROBLEM: "a visitor's identity check doesn't pass",
};

export const KIND_OF: Record<Exclude<OperatorEventType, "installation.test" | "tour.time_requested" | "cleaning.update" | "repairs.update">, UpdateKind> = {
  "tour.booked": "TOUR_BOOKED",
  "tour.started": "TOUR_STARTED",
  "tour.completed": "TOUR_COMPLETED",
  "tour.cancelled": "TOUR_CANCELLED",
  "exception.created": "EXCEPTION_CREATED",
  "access.problem": "ACCESS_PROBLEM",
  "verification.problem": "VERIFICATION_PROBLEM",
};

export interface NotificationPreferences {
  schemaVersion: 1;
  enabled: UpdateKind[];
  /**
   * When each kind was turned on. Anything that happened before isn't
   * announced late (issues use the alerts baseline instead).
   */
  since: Partial<Record<UpdateKind, string>>;
  updatedAt: string;
}

export function enabledUpdates(prefs: NotificationPreferences | undefined): UpdateKind[] {
  return prefs ? prefs.enabled : PROBLEMS_ONLY;
}

/** Whether this event is one the landlord asked to hear about, and happened after they asked. */
export function wants(prefs: NotificationPreferences | undefined, event: OperatorEvent): boolean {
  if (event.eventType === "installation.test" || event.eventType === "tour.time_requested") return true;
  // Cleaner Core's own outbox carries these. Tour Core never announces one.
  if (event.eventType === "cleaning.update" || event.eventType === "repairs.update") return false;
  const kind = KIND_OF[event.eventType];
  if (!enabledUpdates(prefs).includes(kind)) return false;
  const since = prefs?.since[kind];
  return !since || Date.parse(event.occurredAt) > Date.parse(since);
}

/** New preferences; kinds turned on now start now, kinds already on keep their start. */
export function choosePreferences(previous: NotificationPreferences | undefined, enabled: UpdateKind[], now: Date): NotificationPreferences {
  const before = enabledUpdates(previous);
  const since: Partial<Record<UpdateKind, string>> = {};
  for (const kind of enabled) {
    const kept = previous?.since[kind];
    if (before.includes(kind)) {
      if (kept) since[kind] = kept;
    } else since[kind] = now.toISOString();
  }
  return { schemaVersion: 1, enabled: UPDATE_KINDS.filter((k) => enabled.includes(k)), since, updatedAt: now.toISOString() };
}

/** "bookings, tour starts and completions, and anything that needs your attention" */
export function describeUpdates(enabled: UpdateKind[]): string {
  const tours = [
    enabled.includes("TOUR_BOOKED") && "bookings",
    enabled.includes("TOUR_STARTED") && "tour starts",
    enabled.includes("TOUR_COMPLETED") && "completions",
    enabled.includes("TOUR_CANCELLED") && "cancellations",
  ].filter((x): x is string => !!x);
  const problems = PROBLEMS_ONLY.filter((k) => enabled.includes(k));
  const issues = problems.length === PROBLEMS_ONLY.length ? "anything that needs your attention" : problems.map((k) => `when ${UPDATE_LABELS[k]}`).join(" or ");
  const tourText = tours.length <= 1 ? (tours[0] ?? "") : `${tours.slice(0, -1).join(", ")} and ${tours.at(-1)}`;
  if (tourText && issues) return `${tourText}, and ${issues}`;
  return tourText || issues || "nothing";
}
