import { describe, expect, it } from "vitest";
import { buildVisits, RULES, type DeriveContext } from "../src/visits/derive";
import { cleaningDue, fixerDue } from "../src/visits/due";
import type { CodeNames, VisitEvent, WindowEvent } from "../src/visits/events";

/**
 * #237: visit records derived from the raw log, and what's due from them. Made-up property, made-up codes, fake lock
 * events only. Times are New York: 16:00Z is 11 AM on 4 Jan 2027.
 */

const NY = "America/New_York";
const CODES: CodeNames = { Cleaner: { role: "cleaner" }, Ace: { role: "pro", proId: "p-1" }, Guests: { role: "guest" }, Main: { role: "shared" } };
const ctx = (now: string) => ({ timeZone: NY, codeNames: CODES, now: new Date(now) });
const connected: VisitEvent = { type: "lock-connection", id: "conn", at: "2026-12-20T00:00:00.000Z", connected: true };

function cleaning(jobId: string, opts: Partial<WindowEvent> = {}): WindowEvent {
  return {
    type: "visit-window",
    id: `w-${jobId}-${opts.from ?? "a"}`,
    at: "2027-01-01T00:00:00.000Z",
    visit: `cleaning:${jobId}`,
    kind: "cleaning",
    from: "2027-01-04T16:00:00.000Z",
    until: "2027-01-04T21:00:00.000Z",
    expectedAt: "2027-01-04T16:00:00.000Z",
    sameDay: true,
    checkIn: "2027-01-04T21:00:00.000Z",
    who: { role: "cleaner", name: "Maria Lopez" },
    ...opts,
  };
}

const repair = (jobId: string, from: string, until: string): WindowEvent => ({
  type: "visit-window",
  id: `w-${jobId}`,
  at: "2027-01-01T00:00:00.000Z",
  visit: `repair:${jobId}`,
  kind: "repair",
  from,
  until,
  expectedAt: from,
  sameDay: false,
  who: { role: "pro", name: "Ace Plumbing", proId: "p-1" },
});

const unlock = (id: string, at: string, codeName?: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "unlock", side: "outside", ...(codeName ? { codeName } : {}) });
const lockOut = (id: string, at: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "lock", side: "outside" });
const done = (id: string, at: string, visit = "cleaning:j1"): VisitEvent => ({ type: "message", id, at, direction: "in", role: "cleaner", visit, label: "done" });
const said = (id: string, at: string, visit = "cleaning:j1"): VisitEvent => ({ type: "message", id, at, direction: "in", role: "cleaner", visit, label: "start" });

const seen = (id: string, at: string, opts: { label?: string; kind?: "motion" | "ding"; device?: string } = {}): VisitEvent => ({ type: "camera", id, at, kind: opts.kind ?? "motion", deviceId: "cam-1", provider: "ring", device: opts.device ?? "Front porch", label: opts.label ?? "human" });
const counted = (event: string, at: string, people: number): VisitEvent => ({ type: "camera-count", id: `count:${event}:vision-v1`, at, event, counter: "vision-v1", people, vehicles: 0, animals: 0 });
const camCtx = (now: string) => ({ ...ctx(now), cameras: true });

describe("camera departures (#237, #240)", () => {
  const NOW = "2027-01-04T22:00:00.000Z";
  const base = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), done("d1", "2027-01-04T18:40:00.000Z")];
  const departure = (events: VisitEvent[], context: DeriveContext = camCtx(NOW)) => buildVisits(events, context).visits[0]!.departure;

  it("takes the camera's time when DONE has no lock from outside near it", () => {
    const [visit] = buildVisits([...base, seen("c1", "2027-01-04T18:47:00.000Z")], camCtx(NOW)).visits;
    expect(visit!.departure).toEqual({
      at: "2027-01-04T18:47:00.000Z",
      source: "done-text",
      eventId: "c1",
      doneAt: "2027-01-04T18:40:00.000Z",
      lockCheck: "none",
      timeFrom: "camera",
      cameraCheck: "seen",
      camera: { at: "2027-01-04T18:47:00.000Z", device: "Front porch", eventId: "c1" },
    });
    expect(visit!.minutes).toBe(157);
  });

  it("keeps the lock's time and attaches the sighting as support", () => {
    expect(departure([...base, lockOut("l1", "2027-01-04T18:45:00.000Z"), seen("c1", "2027-01-04T18:47:00.000Z")])).toMatchObject({
      at: "2027-01-04T18:45:00.000Z",
      eventId: "l1",
      lockCheck: "matched",
      timeFrom: "lock",
      cameraCheck: "seen",
      camera: { eventId: "c1" },
    });
    expect(departure([...base, lockOut("l1", "2027-01-04T18:45:00.000Z")])).toMatchObject({ timeFrom: "lock", cameraCheck: "none" });
  });

  it("keeps DONE's time when nobody was seen", () => {
    const d = departure(base);
    expect(d).toMatchObject({ at: "2027-01-04T18:40:00.000Z", eventId: "d1", timeFrom: "done", cameraCheck: "none" });
    expect(d).not.toHaveProperty("camera");
  });

  it("never makes a departure without a DONE", () => {
    const events = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), seen("c1", "2027-01-04T18:47:00.000Z"), seen("c2", "2027-01-04T20:30:00.000Z")];
    const [visit] = buildVisits(events, camCtx(NOW)).visits;
    expect(visit!.departure).toBeUndefined();
    expect(visit!.minutes).toBeUndefined();
    expect(visit!.flags.map((flag) => flag.kind)).toContain("no-done");
  });

  it("reads a sighting only from 15 minutes before DONE to 60 minutes after", () => {
    expect(departure([...base, seen("c1", "2027-01-04T18:24:00.000Z"), seen("c2", "2027-01-04T19:41:00.000Z")])).toMatchObject({ timeFrom: "done", cameraCheck: "none" });
    expect(departure([...base, seen("c1", "2027-01-04T18:25:00.000Z")])).toMatchObject({ timeFrom: "camera", at: "2027-01-04T18:25:00.000Z" });
    expect(departure([...base, seen("c1", "2027-01-04T19:40:00.000Z")])).toMatchObject({ timeFrom: "camera", at: "2027-01-04T19:40:00.000Z" });
  });

  it("takes the last of several sightings", () => {
    expect(departure([...base, seen("c1", "2027-01-04T18:42:00.000Z"), seen("c3", "2027-01-04T18:55:00.000Z"), seen("c2", "2027-01-04T18:50:00.000Z")])).toMatchObject({ at: "2027-01-04T18:55:00.000Z", camera: { eventId: "c3" } });
  });

  it("stops at the next unlock after DONE, and at the next check-in", () => {
    // A guest lets themselves in at 2:00 PM: the person on the porch at 2:05 is more likely them.
    expect(departure([...base, seen("c1", "2027-01-04T18:44:00.000Z"), unlock("u2", "2027-01-04T19:00:00.000Z", "Guests"), seen("c2", "2027-01-04T19:05:00.000Z")])).toMatchObject({ at: "2027-01-04T18:44:00.000Z", camera: { eventId: "c1" } });
    const late = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), done("d1", "2027-01-04T20:50:00.000Z"), seen("c1", "2027-01-04T20:55:00.000Z"), seen("c2", "2027-01-04T21:05:00.000Z")];
    expect(departure(late)).toMatchObject({ at: "2027-01-04T20:55:00.000Z", camera: { eventId: "c1" } });
  });

  it("doesn't read a sighting before the arrival", () => {
    const events = [connected, cleaning("j1"), seen("c1", "2027-01-04T18:30:00.000Z"), unlock("u1", "2027-01-04T18:35:00.000Z", "Cleaner"), done("d1", "2027-01-04T18:40:00.000Z")];
    expect(departure(events)).toMatchObject({ timeFrom: "done", cameraCheck: "none" });
  });

  it("goes by our own count over the label, and never by a doorbell press", () => {
    expect(departure([...base, seen("c1", "2027-01-04T18:47:00.000Z"), counted("c1", "2027-01-04T18:47:00.000Z", 0)])).toMatchObject({ cameraCheck: "none" });
    expect(departure([...base, seen("c1", "2027-01-04T18:47:00.000Z", { label: "other_motion" }), counted("c1", "2027-01-04T18:47:00.000Z", 2)])).toMatchObject({ cameraCheck: "seen", timeFrom: "camera" });
    expect(departure([...base, seen("c1", "2027-01-04T18:47:00.000Z", { label: "vehicle" })])).toMatchObject({ cameraCheck: "none" });
    expect(departure([...base, seen("c1", "2027-01-04T18:47:00.000Z", { kind: "ding" })])).toMatchObject({ cameraCheck: "none" });
  });

  it("ignores camera lines with cameras off", () => {
    const events = [...base, seen("c1", "2027-01-04T18:47:00.000Z")];
    for (const context of [ctx(NOW), { ...ctx(NOW), cameras: false }]) {
      const d = departure(events, context);
      expect(d).toEqual({ at: "2027-01-04T18:40:00.000Z", source: "done-text", eventId: "d1", doneAt: "2027-01-04T18:40:00.000Z", lockCheck: "none", timeFrom: "done", cameraCheck: "no-camera" });
    }
  });

  it("gives the time at a property with cameras and no lock", () => {
    const events = [cleaning("j1"), said("s1", "2027-01-04T16:10:00.000Z"), done("d1", "2027-01-04T18:40:00.000Z"), seen("c1", "2027-01-04T18:47:00.000Z")];
    const [visit] = buildVisits(events, camCtx(NOW)).visits;
    expect(visit!.departure).toMatchObject({ at: "2027-01-04T18:47:00.000Z", lockCheck: "no-lock", timeFrom: "camera", cameraCheck: "seen" });
    expect(visit!.flags).toEqual([]);
  });

  it("supports a crew day's lock departure and never makes one", () => {
    const day: WindowEvent = { ...repair("r1", "2027-01-04T14:00:00.000Z", "2027-01-04T22:00:00.000Z"), visit: "crew:r1:2027-01-04", kind: "crew-day" };
    const withLock = [connected, day, unlock("u1", "2027-01-04T14:05:00.000Z", "Ace"), lockOut("l1", "2027-01-04T21:30:00.000Z"), seen("c1", "2027-01-04T21:32:00.000Z")];
    expect(departure(withLock, camCtx("2027-01-05T00:00:00.000Z"))).toEqual({ at: "2027-01-04T21:30:00.000Z", source: "lock", eventId: "l1", lockCheck: "matched", timeFrom: "lock", cameraCheck: "seen", camera: { at: "2027-01-04T21:32:00.000Z", device: "Front porch", eventId: "c1" } });
    const noLock = [connected, day, unlock("u1", "2027-01-04T14:05:00.000Z", "Ace"), seen("c1", "2027-01-04T21:32:00.000Z")];
    expect(departure(noLock, camCtx("2027-01-05T00:00:00.000Z"))).toBeUndefined();
  });

  it("is rule version 2", () => {
    expect(RULES).toBe(2);
  });
});

describe("visit records", () => {
  it("measures a cleaning from the cleaner's code to the lock after DONE", () => {
    const events = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), done("d1", "2027-01-04T18:40:00.000Z"), lockOut("l1", "2027-01-04T18:45:00.000Z")];
    const [visit] = buildVisits(events, ctx("2027-01-04T22:00:00.000Z")).visits;
    expect(visit).toMatchObject({
      id: "cleaning:j1",
      lock: true,
      arrival: { at: "2027-01-04T16:10:00.000Z", source: "lock", eventId: "u1" },
      departure: { at: "2027-01-04T18:45:00.000Z", source: "done-text", eventId: "l1", doneAt: "2027-01-04T18:40:00.000Z", lockCheck: "matched" },
      minutes: 155,
      flags: [],
      rules: RULES,
    });
  });

  it("keeps DONE's time when no lock from outside is near it, and says so", () => {
    const events = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), done("d1", "2027-01-04T18:40:00.000Z"), lockOut("l1", "2027-01-04T20:00:00.000Z")];
    const [visit] = buildVisits(events, ctx("2027-01-04T22:00:00.000Z")).visits;
    expect(visit?.departure).toEqual({ at: "2027-01-04T18:40:00.000Z", source: "done-text", eventId: "d1", doneAt: "2027-01-04T18:40:00.000Z", lockCheck: "none", timeFrom: "done", cameraCheck: "no-camera" });
  });

  it("counts a shared or unnamed code only when one visit alone was open", () => {
    const alone = buildVisits([connected, cleaning("j1"), unlock("u1", "2027-01-04T16:05:00.000Z", "Main")], ctx("2027-01-04T17:00:00.000Z")).visits;
    expect(alone[0]?.arrival).toEqual({ at: "2027-01-04T16:05:00.000Z", source: "lock-unnamed", eventId: "u1" });
    const both = buildVisits([connected, cleaning("j1"), repair("r1", "2027-01-04T15:30:00.000Z", "2027-01-04T17:30:00.000Z"), unlock("u1", "2027-01-04T16:05:00.000Z")], ctx("2027-01-04T17:00:00.000Z")).visits;
    expect(both.every((visit) => visit.arrival === undefined)).toBe(true);
  });

  it("never counts a guest's code as an arrival", () => {
    const [visit] = buildVisits([connected, cleaning("j1"), unlock("u1", "2027-01-04T16:05:00.000Z", "Guests")], ctx("2027-01-04T17:00:00.000Z")).visits;
    expect(visit?.arrival).toBeUndefined();
  });

  it("without a lock, takes times from the cleaner's texts and flags nothing", () => {
    const events = [cleaning("j1"), said("s1", "2027-01-04T17:30:00.000Z"), done("d1", "2027-01-04T19:00:00.000Z")];
    const derived = buildVisits(events, ctx("2027-01-05T03:00:00.000Z"));
    expect(derived.visits[0]).toMatchObject({
      lock: false,
      arrival: { at: "2027-01-04T17:30:00.000Z", source: "cleaner-text" },
      departure: { at: "2027-01-04T19:00:00.000Z", source: "done-text", lockCheck: "no-lock" },
      minutes: 90,
      flags: [],
    });
    expect(cleaningDue(derived, { now: new Date("2027-01-04T20:00:00.000Z"), timeZone: NY, address: "12 Scratch Lane", sent: () => false })).toEqual([]);
  });

  it("flags a late arrival, a missing DONE, and a no-show", () => {
    const late = buildVisits([connected, cleaning("j1"), unlock("u1", "2027-01-04T16:40:00.000Z", "Cleaner")], ctx("2027-01-04T21:30:00.000Z")).visits[0]!;
    expect(late.flags).toEqual([
      { kind: "late", at: "2027-01-04T16:40:00.000Z" },
      { kind: "no-done", at: "2027-01-04T21:00:00.000Z" },
      { kind: "not-ready", at: "2027-01-04T20:00:00.000Z", why: ["not-done"] },
    ]);
    const none = buildVisits([connected, cleaning("j1")], ctx("2027-01-04T21:30:00.000Z")).visits[0]!;
    expect(none.flags.map((flag) => flag.kind)).toEqual(["late", "at-risk", "no-show", "not-ready"]);
  });

  it("uses the latest window, and leaves out a cancelled visit", () => {
    const moved = cleaning("j1", { id: "w-moved", from: "2027-01-04T18:00:00.000Z", expectedAt: "2027-01-04T18:00:00.000Z" });
    const derived = buildVisits([connected, cleaning("j1"), moved, cleaning("j2", { visit: "cleaning:j2", id: "w-j2" }), { type: "visit-cancelled", id: "c-j2", at: "2027-01-02T00:00:00.000Z", visit: "cleaning:j2" }], ctx("2027-01-04T16:50:00.000Z"));
    expect(derived.visits.map((visit) => visit.id)).toEqual(["cleaning:j1"]);
    expect(derived.visits[0]?.window.from).toBe("2027-01-04T18:00:00.000Z");
    expect(derived.visits[0]?.flags).toEqual([]);
  });

  it("rebuilds the same records from the same raw lines, every time", () => {
    const events = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:10:00.000Z", "Cleaner"), done("d1", "2027-01-04T18:40:00.000Z"), lockOut("l1", "2027-01-04T18:45:00.000Z")];
    const frozen = JSON.stringify(events);
    const first = buildVisits(events, ctx("2027-01-04T22:00:00.000Z"));
    const second = buildVisits(JSON.parse(frozen) as VisitEvent[], ctx("2027-01-04T22:00:00.000Z"));
    expect(second).toEqual(first);
    expect(JSON.stringify(events)).toBe(frozen);
  });

  it("measures a repair from the pro's code to their done on the visit page", () => {
    const events: VisitEvent[] = [
      connected,
      repair("r1", "2027-01-06T15:00:00.000Z", "2027-01-06T17:00:00.000Z"),
      unlock("u1", "2027-01-06T14:50:00.000Z", "Ace"),
      { type: "visit-page", id: "p1", at: "2027-01-06T16:20:00.000Z", visit: "repair:r1", step: "done" },
      lockOut("l1", "2027-01-06T16:25:00.000Z"),
    ];
    const [visit] = buildVisits(events, ctx("2027-01-06T18:00:00.000Z")).visits;
    expect(visit).toMatchObject({ arrival: { source: "lock", at: "2027-01-06T14:50:00.000Z" }, departure: { source: "done-page", lockCheck: "matched", at: "2027-01-06T16:25:00.000Z" }, minutes: 95 });
  });

  it("measures a crew day from the crew's code to the last lock from outside", () => {
    const day: WindowEvent = { ...repair("c1", "2027-01-07T13:00:00.000Z", "2027-01-07T22:00:00.000Z"), visit: "crew:c1:2027-01-07", kind: "crew-day", id: "w-crew" };
    const events = [connected, day, unlock("u1", "2027-01-07T13:05:00.000Z", "Ace"), lockOut("l1", "2027-01-07T17:00:00.000Z"), lockOut("l2", "2027-01-07T21:50:00.000Z")];
    const [visit] = buildVisits(events, ctx("2027-01-08T00:00:00.000Z")).visits;
    expect(visit).toMatchObject({ arrival: { at: "2027-01-07T13:05:00.000Z" }, departure: { source: "lock", at: "2027-01-07T21:50:00.000Z", lockCheck: "matched" }, minutes: 525 });
  });
});

describe("what's due from visit records", () => {
  const due = (events: VisitEvent[], now: string, sent: (id: string) => boolean = () => false) =>
    cleaningDue(buildVisits(events, ctx(now)), { now: new Date(now), timeZone: NY, address: "12 Scratch Lane", cleanerName: "Maria Lopez", sent });

  it("texts the cleaner at the expected time plus 15 minutes on a same-day turnover, not before", () => {
    expect(due([connected, cleaning("j1")], "2027-01-04T16:14:00.000Z")).toEqual([]);
    expect(due([connected, cleaning("j1")], "2027-01-04T16:15:00.000Z")).toEqual([
      { id: "late-ask:j1", to: "cleaner", kind: "late-ask", jobId: "j1", body: "Hi Maria, checking in on today's clean at 12 Scratch Lane. Are you on your way?" },
    ]);
  });

  it("waits 30 minutes when the next check-in is another day", () => {
    const window = cleaning("j1", { sameDay: false, until: "2027-01-05T01:00:00.000Z", checkIn: "2027-01-05T21:00:00.000Z" });
    expect(due([connected, window], "2027-01-04T16:29:00.000Z")).toEqual([]);
    expect(due([connected, window], "2027-01-04T16:30:00.000Z").map((item) => item.id)).toEqual(["late-ask:j1"]);
  });

  it("asks nothing once the cleaner came in", () => {
    expect(due([connected, cleaning("j1"), unlock("u1", "2027-01-04T16:20:00.000Z", "Cleaner")], "2027-01-04T16:30:00.000Z")).toEqual([]);
  });

  it("tells the host when the next check-in is at risk, from a 3-hour clean until five are measured", () => {
    // 4 PM check-in, less 3 hours and 30 minutes: 12:30 PM.
    expect(due([connected, cleaning("j1")], "2027-01-04T17:29:00.000Z").map((item) => item.id)).toEqual(["late-ask:j1"]);
    const atRisk = due([connected, cleaning("j1")], "2027-01-04T17:30:00.000Z");
    expect(atRisk.map((item) => item.id)).toEqual(["late-ask:j1", "at-risk:j1"]);
    expect(atRisk[1]).toMatchObject({ to: "host", body: "Maria Lopez hasn't arrived at 12 Scratch Lane yet. The next guests check in at 4 PM." });
  });

  it("uses the median of the last five measured cleans for the at-risk time", () => {
    const past: VisitEvent[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const day = `2026-12-${String(10 + i).padStart(2, "0")}`;
      past.push(cleaning(`p${i}`, { id: `w-p${i}`, visit: `cleaning:p${i}`, from: `${day}T16:00:00.000Z`, until: `${day}T21:00:00.000Z`, expectedAt: `${day}T16:00:00.000Z`, checkIn: `${day}T21:00:00.000Z` }));
      past.push(unlock(`pu${i}`, `${day}T16:00:00.000Z`, "Cleaner"), done(`pd${i}`, `${day}T18:00:00.000Z`, `cleaning:p${i}`));
    }
    const derived = buildVisits([connected, ...past, cleaning("j1")], ctx("2027-01-04T18:00:00.000Z"));
    expect(derived.cleanMinutes).toBe(120);
    // 4 PM less 2 hours and 30 minutes: 1:30 PM.
    expect(derived.visits.find((visit) => visit.id === "cleaning:j1")?.times.atRiskAt).toBe("2027-01-04T18:30:00.000Z");
  });

  it("tells the host of a no-show only when no at-risk note went", () => {
    const window = cleaning("j1", { sameDay: false, checkIn: undefined, until: "2027-01-05T01:00:00.000Z" });
    const items = due([connected, window], "2027-01-05T01:00:00.000Z");
    expect(items.map((item) => item.id)).toEqual(["no-show:j1"]);
    expect(items[0]?.body).toBe("Maria Lopez didn't arrive for the clean at 12 Scratch Lane. No one had come in by 8 PM.");
    expect(due([connected, cleaning("j1")], "2027-01-04T21:00:00.000Z", (id) => id === "at-risk:j1").map((item) => item.id)).toEqual([]);
    // A no-show isn't told days later, after a restart.
    expect(due([connected, window], "2027-01-05T13:00:00.000Z")).toEqual([]);
  });

  it("checks arrival-day readiness and names each reason", () => {
    const base = [connected, cleaning("j1"), unlock("u1", "2027-01-04T16:05:00.000Z", "Cleaner")];
    // Same-day: an hour before the 4 PM check-in.
    expect(due([...base, done("d1", "2027-01-04T18:00:00.000Z"), lockOut("l1", "2027-01-04T18:05:00.000Z")], "2027-01-04T20:00:00.000Z")).toEqual([]);
    const open = due([...base, done("d1", "2027-01-04T18:00:00.000Z"), lockOut("l1", "2027-01-04T18:05:00.000Z"), unlock("u2", "2027-01-04T19:00:00.000Z", "Cleaner"), repair("r1", "2027-01-04T20:30:00.000Z", "2027-01-04T21:30:00.000Z")], "2027-01-04T20:00:00.000Z");
    expect(open).toEqual([
      { id: "not-ready:j1", to: "host", kind: "not-ready", jobId: "j1", body: "Before the 4 PM check-in at 12 Scratch Lane: a repair visit runs into check-in, and the door wasn't locked after the cleaning." },
    ]);
    const undone = due(base, "2027-01-04T20:00:00.000Z");
    expect(undone.find((item) => item.kind === "not-ready")?.body).toBe("Before the 4 PM check-in at 12 Scratch Lane: the cleaning isn't marked done.");
  });

  it("tells the host once a day when the cleaner's code opens the door outside any cleaning", () => {
    const events = [connected, cleaning("j1"), unlock("u1", "2027-01-06T03:00:00.000Z", "Cleaner"), unlock("u2", "2027-01-06T03:30:00.000Z", "Cleaner")];
    expect(due(events, "2027-01-06T04:00:00.000Z")).toEqual([
      { id: "stray:cleaner:2027-01-05", to: "host", kind: "stray", body: "The cleaner's code opened the front door at 12 Scratch Lane at 10 PM, when no cleaning was booked." },
    ]);
  });

  it("never says ready or door code, which Cleaner Core refuses", () => {
    const events = [connected, cleaning("j1"), unlock("u9", "2027-01-06T03:00:00.000Z", "Cleaner")];
    for (const now of ["2027-01-04T16:20:00.000Z", "2027-01-04T17:40:00.000Z", "2027-01-04T20:10:00.000Z", "2027-01-06T04:00:00.000Z"]) {
      for (const item of due(events, now)) expect(item.body).not.toMatch(/\bready\b|door code/i);
    }
  });

  it("gives Fixer Core one news item for a pro or crew not in by the start plus 30 minutes, and a stray code", () => {
    const day: WindowEvent = { ...repair("c1", "2027-01-07T13:00:00.000Z", "2027-01-07T22:00:00.000Z"), visit: "crew:c1:2027-01-07", kind: "crew-day", id: "w-crew" };
    const events = [connected, repair("r1", "2027-01-07T15:00:00.000Z", "2027-01-07T17:00:00.000Z"), day, unlock("u1", "2027-01-08T03:00:00.000Z", "Ace")];
    const items = (now: string) => fixerDue(buildVisits(events, ctx(now)), { now: new Date(now), timeZone: NY, proName: () => "Ace Plumbing" });
    expect(items("2027-01-07T13:29:00.000Z")).toEqual([]);
    expect(items("2027-01-07T15:30:00.000Z")).toEqual([
      { kind: "crew-no-arrival:2027-01-07", jobId: "c1", text: "No one from Ace Plumbing's crew has come in yet. Work was due to start at 8 AM." },
      { kind: "visit-no-arrival", jobId: "r1", text: "Ace Plumbing hasn't arrived for the visit that started at 10 AM." },
    ]);
    expect(items("2027-01-08T04:00:00.000Z")).toEqual([{ kind: "visit-stray:p-1:2027-01-07", text: "Ace Plumbing's code opened the front door at 10 PM, outside their visit." }]);
  });
});
