import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedInstant } from "../src/hub/calendar";
import { ALERT_KEEPS_MS, runHostAlerts, type AlertSink, type AlertSource, type HostAlert } from "../src/host-alerts/clock";
import { alertProblem } from "../src/host-alerts/guard";
import { HOST_ALERTS_FILE, HostAlertLedger, readHostAlerts } from "../src/host-alerts/ledger";
import { ALERT_KINDS, routineFor, ROUTES_FILE } from "../src/host-alerts/routes";
import { oversightSource, packageSource } from "../src/host-alerts/sources";
import { oversightDeskFor } from "../src/oversight/desk";
import { readOversight } from "../src/oversight/store";
import { NOT_SEEN_PENDING, packageDeskFor } from "../src/package-arrivals/desk";
import { readPackages } from "../src/package-arrivals/store";
import { resetVisitLogCache } from "../src/visits/store";
import { cleanupFolders, order, propertyFolder, writeOrders } from "./packageFixture";

/** #250: the routing point, the leak guard, the ledger and the clock's exactly-once order. Made-up properties, 555 numbers and made-up codes only. */

const NY = "America/New_York";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupFolders();
  resetVisitLogCache();
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "host-alerts-"));
  roots.push(root);
  return root;
}

describe("the routing point", () => {
  it("sends every kind to the one Alerts routine by default", () => {
    const account = folder();
    for (const kind of ALERT_KINDS) expect(routineFor(account, kind)).toBe("alerts");
  });

  it("reads a saved map, and an unknown routine, a broken file or a missing kind falls back to the Alerts routine", () => {
    const account = folder();
    writeFileSync(join(account, ROUTES_FILE), JSON.stringify({ routes: { "stay-night": "alerts", "camera-health": "camera-bot" } }));
    expect(routineFor(account, "stay-night")).toBe("alerts");
    expect(routineFor(account, "camera-health")).toBe("alerts");
    expect(routineFor(account, "packages")).toBe("alerts");
    writeFileSync(join(account, ROUTES_FILE), "{nope");
    expect(routineFor(account, "oversight")).toBe("alerts");
  });

  it("routes by team (#250)", () => {
    const root = folder();
    expect(routineFor(root, "packages")).toBe("alerts");
    expect(routineFor(root, "packages", { suppliesOwnBot: true })).toBe("supplies");
    expect(routineFor(root, "packages", { suppliesOwnBot: false })).toBe("property");
    for (const kind of ["stay-night", "camera-health", "oversight"] as const) expect(routineFor(root, kind, { suppliesOwnBot: true })).toBe("property");
  });

  it("a saved route still wins on a team", () => {
    const root = folder();
    writeFileSync(join(root, ROUTES_FILE), JSON.stringify({ routes: { packages: "property", oversight: "alerts" } }));
    expect(routineFor(root, "packages", { suppliesOwnBot: true })).toBe("property");
    expect(routineFor(root, "oversight", { suppliesOwnBot: true })).toBe("alerts");
    expect(routineFor(root, "stay-night", { suppliesOwnBot: true })).toBe("property");
  });
});

describe("the ledger's shown mark (#250)", () => {
  const NOW = new Date("2026-11-21T22:00:00.000Z");

  it("shown is separate from delivered, and a shown alert is no longer pending", () => {
    const root = folder();
    const ledger = new HostAlertLedger(root, () => NOW);
    ledger.keep({ id: "a1", kind: "packages", text: "A package for Scratch Lane arrived." });
    expect(ledger.unshown(["packages"]).map((a) => a.id)).toEqual(["a1"]);
    expect(ledger.unshown(["oversight"])).toEqual([]);
    ledger.shown("a1");
    expect(ledger.unshown(["packages"])).toEqual([]);
    expect(ledger.pending()).toEqual([]);
    expect(readHostAlerts(root).alerts[0]!.deliveredAt).toBeUndefined();
    expect(readHostAlerts(root).alerts[0]!.shownAt).toBe(NOW.toISOString());
  });

  it("an alert a wake-up was sent for is still unshown, and one a desk's notes took is not", () => {
    const root = folder();
    const ledger = new HostAlertLedger(root, () => NOW);
    ledger.keep({ id: "woken", kind: "packages", text: "A made-up package note." });
    ledger.keep({ id: "noted", kind: "packages", text: "A second made-up package note." });
    ledger.keep({ id: "withheld-twin", kind: "oversight", text: "A made-up visit note." });
    ledger.delivered("woken", "supplies");
    ledger.delivered("noted", "fixer");
    expect(ledger.unshown(["packages"]).map((a) => a.id)).toEqual(["woken"]);
    ledger.withhold({ id: "held", kind: "packages" });
    expect(ledger.unshown(["packages", "oversight"]).map((a) => a.id)).toEqual(["woken", "withheld-twin"]);
  });
});

describe("the leak guard", () => {
  it("passes each producer's own wording, with clock times and the property's street number", () => {
    const label = "1250 Scratch Lane";
    expect(alertProblem("Today at 1250 Scratch Lane: Mike Doyle was expected between 1 PM and 5 PM (walk-through). No one came in by 6 PM. The Front porch camera saw someone at 2:08 PM.", { label })).toBeUndefined();
    expect(alertProblem("Tonight at 1250 Scratch Lane: 8 people on camera at 11:02 PM, and the house rules allow 6. Clip: Front door camera, 11:02 PM.", { label })).toBeUndefined();
    expect(alertProblem("The Front door camera at 1250 Scratch Lane has been offline since 2:10 PM. Check its power and Wi-Fi.", { label })).toBeUndefined();
    expect(alertProblem("A package from Example Mart (Paper towels x2) was expected at 1250 Scratch Lane today, and nothing confirmed it arrived by 9 PM. Check its tracking.", { label })).toBeUndefined();
  });

  it("refuses a door code, split digits of one, and a phone number", () => {
    expect(alertProblem("Today at Lake House: the code is 7306.")).toBe("digits");
    expect(alertProblem("Today at Lake House: use 7 3 0 6 at the door.")).toBe("digits");
    expect(alertProblem("Today at Lake House: use 73-06.")).toBe("digits");
    expect(alertProblem("Call 555-555-0142 about it.")).toBe("digits");
    expect(alertProblem("Call +1 555 555 0142 about it.")).toBe("phone");
    expect(alertProblem("Call +15555550142.")).toBe("phone");
    // Only the property's own name is let through, not a code that happens to follow it.
    expect(alertProblem("Today at 1250 Scratch Lane: code 7306.", { label: "1250 Scratch Lane" })).toBe("digits");
  });
});

/** A source that hands back fixed alerts and counts its commits. */
function fixed(kind: HostAlert["kind"], alerts: HostAlert[], commits: string[]): AlertSource {
  return { kind, due: () => alerts.map((alert) => ({ alert, commit: () => void commits.push(alert.id) })) };
}

describe("the clock's pass", () => {
  const NOW = new Date("2026-11-21T22:00:00.000Z");

  it("keeps an alert, then marks it told, then hands it over, and a second run sends nothing", async () => {
    const root = folder();
    const order: string[] = [];
    const ledger = new HostAlertLedger(root, () => NOW);
    const alert: HostAlert = { id: "packages:supply:o1:not-seen", kind: "packages", text: "A package from Example Mart was expected at Lake House today, and nothing confirmed it arrived by 9 PM. Check its tracking." };
    const source: AlertSource = {
      kind: "packages",
      due: () => [{ alert, commit: () => order.push(`commit:${ledger.has(alert.id)}`) }],
    };
    const handed: HostAlert[] = [];
    const sink: AlertSink = async (a) => (handed.push(a), order.push("sink"), "cleaning");
    const first = await runHostAlerts({ sources: [source], ledger, sinkFor: () => sink, now: NOW });
    expect(first).toMatchObject({ kept: [alert.id], delivered: [alert.id], withheld: [] });
    // Kept before the producer marked it, and handed over after.
    expect(order).toEqual(["commit:true", "sink"]);
    const second = await runHostAlerts({ sources: [source], ledger, sinkFor: () => sink, now: NOW });
    expect(second).toMatchObject({ kept: [], delivered: [] });
    expect(handed).toHaveLength(1);
    expect(readHostAlerts(root).alerts).toEqual([expect.objectContaining({ id: alert.id, deliveredAt: NOW.toISOString(), via: "cleaning" })]);
  });

  it("an alert no routine took is handed over on a later pass, after a restart, once", async () => {
    const root = folder();
    const commits: string[] = [];
    const alert: HostAlert = { id: "camera-offline:off-1", kind: "camera-health", text: "The Front door camera at Lake House has been offline since 2:10 PM. Check its power and Wi-Fi." };
    let up = false;
    const handed: string[] = [];
    const sink: AlertSink = async (a) => (up ? (handed.push(a.id), "fixer") : undefined);
    // The producer said it once; after that it's marked told and never due again.
    let said = false;
    const once: AlertSource = { kind: "camera-health", due: () => (said ? [] : ((said = true), [{ alert, commit: () => void commits.push(alert.id) }])) };
    await runHostAlerts({ sources: [once], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => sink, now: NOW });
    expect(handed).toEqual([]);
    // A restart: a fresh ledger over the same file.
    up = true;
    await runHostAlerts({ sources: [once], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => sink, now: NOW });
    await runHostAlerts({ sources: [once], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => sink, now: NOW });
    expect(handed).toEqual([alert.id]);
    expect(commits).toEqual([alert.id]);
  });

  it("a producer that hands the same alert again after a crash before its mark is kept once and sent once", async () => {
    const root = folder();
    const alert: HostAlert = { id: "oversight:2026-11-21:v-0000000a", kind: "oversight", text: "Today at Lake House: Mike Doyle was expected today. No one came in by 8 PM." };
    const handed: string[] = [];
    const sink: AlertSink = async (a) => (handed.push(a.id), "cleaning");
    const crashing: AlertSource = { kind: "oversight", due: () => [{ alert, commit: () => { throw new Error("crash before the mark"); } }] };
    const ledger = new HostAlertLedger(root, () => NOW);
    const first = await runHostAlerts({ sources: [crashing], ledger, sinkFor: () => sink, now: NOW });
    expect(first.failed).toEqual(["oversight"]);
    const commits: string[] = [];
    await runHostAlerts({ sources: [fixed("oversight", [alert], commits)], ledger, sinkFor: () => sink, now: NOW });
    expect(commits).toEqual([alert.id]);
    expect(handed).toEqual([alert.id]);
  });

  it("withholds an alert holding a code or a phone number: never kept, never sent, still marked", async () => {
    const root = folder();
    const commits: string[] = [];
    const handed: string[] = [];
    const bad: HostAlert[] = [
      { id: "stay-night:2026-11-20", kind: "stay-night", text: "Tonight at Lake House: the code 7306 was used." },
      { id: "packages:supply:o2:not-seen", kind: "packages", text: "Call +1 555 555 0142." },
    ];
    const result = await runHostAlerts({ sources: [fixed("stay-night", [bad[0]!], commits), fixed("packages", [bad[1]!], commits)], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => async (a) => (handed.push(a.id), "cleaning"), now: NOW });
    expect(result.withheld.map((w) => w.problem)).toEqual(["digits", "phone"]);
    expect(handed).toEqual([]);
    expect(commits).toEqual(bad.map((a) => a.id));
    const raw = readFileSync(join(root, HOST_ALERTS_FILE), "utf8");
    expect(raw).not.toContain("7306");
    expect(raw).not.toContain("0142");
  });

  it("one producer's failure never stops the rest", async () => {
    const root = folder();
    const commits: string[] = [];
    const broken: AlertSource = { kind: "oversight", due: () => { throw new Error("unreadable"); } };
    const fine: HostAlert = { id: "camera-online:on-1", kind: "camera-health", text: "The Front door camera at Lake House is back online." };
    const result = await runHostAlerts({ sources: [broken, fixed("camera-health", [fine], commits)], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => async () => "cleaning", now: NOW });
    expect(result).toMatchObject({ failed: ["oversight"], delivered: [fine.id] });
  });

  it("lets an alert go once it's 48 hours old and never handed over", async () => {
    const root = folder();
    const alert: HostAlert = { id: "camera-online:on-2", kind: "camera-health", text: "The Front door camera at Lake House is back online." };
    await runHostAlerts({ sources: [fixed("camera-health", [alert], [])], ledger: new HostAlertLedger(root, () => NOW), sinkFor: () => async () => undefined, now: NOW });
    const later = new Date(NOW.getTime() + ALERT_KEEPS_MS);
    const handed: string[] = [];
    await runHostAlerts({ sources: [], ledger: new HostAlertLedger(root, () => later), sinkFor: () => async (a) => (handed.push(a.id), "cleaning"), now: later });
    expect(handed).toEqual([]);
    expect(readHostAlerts(root).alerts[0]).toMatchObject({ id: alert.id, expiredAt: later.toISOString() });
    expect(readHostAlerts(root).alerts[0]?.text).toBeUndefined();
  });
});

describe("the producers as sources", () => {
  it("the same-day check is peeked, kept, then flagged by runDay, and a later run of the day has nothing new", async () => {
    const root = folder();
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", timeZone: NY }, calendars: [], stays: [] }));
    let now = new Date("2026-11-19T15:00:00.000Z");
    const desk = oversightDeskFor(root, { now: () => now, locks: () => true, lockedNow: () => true, cameras: () => false });
    const added = desk.addVisit({ who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" });
    const id = (added.structured?.visit as { id: string }).id;
    now = new Date(zonedInstant("2026-11-19", "18:15", NY));
    const source = oversightSource(desk, "2026-11-19", "Lake House");
    // Listing never uses up the flag.
    desk.listVisits();
    expect(readOversight(root).visits[0]?.flaggedAt).toBeUndefined();
    const handed: HostAlert[] = [];
    const ledger = new HostAlertLedger(root, () => now);
    await runHostAlerts({ sources: [source], ledger, sinkFor: () => async (a) => (handed.push(a), "cleaning"), now });
    expect(handed).toEqual([{ id: `oversight:2026-11-19:${id}`, kind: "oversight", text: expect.stringMatching(/^Today at Lake House: Mike Doyle was expected between 1 PM and 5 PM \(walk-through\)\. No one came in by 6 PM\./) }]);
    expect(readOversight(root).visits[0]?.flaggedAt).toBe(now.toISOString());
    now = new Date(zonedInstant("2026-11-19", "21:00", NY));
    await runHostAlerts({ sources: [oversightSource(desk, "2026-11-19", "Lake House")], ledger: new HostAlertLedger(root, () => now), sinkFor: () => async (a) => (handed.push(a), "cleaning"), now });
    expect(handed).toHaveLength(1);
  });

  it("a package not seen by 9 PM is told once, and check_packages then lists it as told, not again", async () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    let now = new Date(zonedInstant("2026-11-21", "20:45", NY));
    const desk = packageDeskFor(root, { now: () => now, alertsByClock: () => true });
    expect(desk.dueNotSeen("12 Scratch Lane")).toEqual([]);
    now = new Date(zonedInstant("2026-11-21", "21:05", NY));
    // check_packages lists it read only while the clock hasn't told it yet.
    const listed = desk.check();
    expect(listed.structured).toMatchObject({ notSeen: [], notSeenPending: [{ orderId: "ord_1" }] });
    expect(String(listed.structured?.next)).toContain(NOT_SEEN_PENDING);
    expect(readPackages(root).arrivals["supply:ord_1"]?.notSeenTold).toBeUndefined();
    const handed: HostAlert[] = [];
    const ledger = new HostAlertLedger(root, () => now);
    await runHostAlerts({ sources: [packageSource(desk, "12 Scratch Lane")], ledger, sinkFor: () => async (a) => (handed.push(a), "fixer"), now });
    await runHostAlerts({ sources: [packageSource(desk, "12 Scratch Lane")], ledger, sinkFor: () => async (a) => (handed.push(a), "fixer"), now });
    expect(handed).toEqual([{ id: "packages:supply:ord_1:not-seen", kind: "packages", text: "A package from Example Mart (Paper towels x2) was expected at 12 Scratch Lane today, and nothing confirmed it arrived by 9 PM. Check its tracking." }]);
    expect(desk.check().structured).toMatchObject({ notSeen: [], waiting: [{ orderId: "ord_1" }] });
  });

  it("without the clock, check_packages marks and tells a package not seen exactly as before", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    const desk = packageDeskFor(root, { now: () => new Date(zonedInstant("2026-11-21", "21:05", NY)) });
    const listed = desk.check();
    expect(listed.structured).toMatchObject({ notSeen: [{ orderId: "ord_1" }] });
    expect(listed.structured?.notSeenPending).toBeUndefined();
    expect(readPackages(root).arrivals["supply:ord_1"]?.notSeenTold).toBe(true);
  });

  it("a package from an earlier day names its day", () => {
    const { root } = propertyFolder();
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-20" })]);
    const desk = packageDeskFor(root, { now: () => new Date(zonedInstant("2026-11-21", "09:00", NY)) });
    expect(desk.dueNotSeen("Scratch Lane")[0]?.text).toContain("expected at Scratch Lane on Friday, November 20,");
  });
});
