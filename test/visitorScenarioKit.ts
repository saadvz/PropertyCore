import type { VisitorDemoSession } from "../src/visitor/session";
import type { LiveApp } from "./liveApp";

/** What reached the landlord: a flagged question or a time request. */
export function reachedLandlord(app: LiveApp): string[] {
  return app
    .outbox()
    .map((r) => r.event.eventType)
    .filter((type) => type === "exception.created" || type === "tour.time_requested");
}

/** The test's one visitor. */
export function visitorSession(app: LiveApp): VisitorDemoSession {
  const sessions = app.visitors.all();
  if (!sessions.length) throw new Error("No visitor yet.");
  return sessions.at(-1)!;
}
