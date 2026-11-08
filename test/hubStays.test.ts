import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { readGoogleCalendarFixture } from "../src/hub/sources";

/** Merged stays and blocks in the hub. Calendar reads are stubbed; nothing reaches the network. */

const NOW = new Date("2026-11-08T15:00:00Z");
const ONE = "https://example.com/one.ics";
const TWO = "https://example.com/two.ics";
const roots: string[] = [];
afterEach(() => {
  resetHubs();
  setCalendarFetch(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const root = mkdtempSync(join(tmpdir(), "stays-"));
  roots.push(root);
  return hubFor(root, { now: () => NOW });
}

function ics(...events: [string, string, string, string][]): string {
  const lines = events.flatMap(([uid, start, end, summary]) => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, `SUMMARY:${summary}`, "END:VEVENT"]);
  return ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n");
}

function serve(bodies: Record<string, string>): void {
  setCalendarFetch(async (url) => ({ status: url in bodies ? 200 : 404, url, async text() { return bodies[url] ?? ""; } }));
}

describe("hub stays", () => {
  it("merges stays and blocks from every feed, sorted by check-in", async () => {
    const hub = open();
    hub.setCalendars({ calendars: [{ name: "One", url: ONE }, { name: "Two", url: TWO }] });
    serve({
      [ONE]: ics(["a", "20261120", "20261123", "Guest"], ["b", "20261110", "20261113", "Guest"]),
      [TWO]: ics(["c", "20261115", "20261117", "Blocked"], ["d", "20261110", "20261113", "Guest"]),
    });
    await hub.readCalendars({ tenantId: "p1" });
    expect(hub.stays()).toEqual([
      { checkIn: "2026-11-10", checkout: "2026-11-13", kind: "stay" },
      { checkIn: "2026-11-15", checkout: "2026-11-17", kind: "block" },
      { checkIn: "2026-11-20", checkout: "2026-11-23", kind: "stay" },
    ]);
  });

  it("a failed read keeps the last stays", async () => {
    const hub = open();
    hub.setCalendars({ calendars: [{ name: "One", url: ONE }, { name: "Two", url: TWO }] });
    serve({ [ONE]: ics(["a", "20261110", "20261113", "Guest"]), [TWO]: ics(["c", "20261115", "20261117", "Blocked"]) });
    await hub.readCalendars({ tenantId: "p1" });
    serve({ [ONE]: ics(["a", "20261201", "20261203", "Guest"]) });
    await hub.readCalendars({ tenantId: "p1" });
    expect(hub.stays()).toHaveLength(2);
    expect(hub.stays()?.[0]).toEqual({ checkIn: "2026-11-10", checkout: "2026-11-13", kind: "stay" });
  });

  it("is undefined before any clean read", () => {
    expect(open().stays()).toBeUndefined();
  });

  it("google stays and blocks carry dates", async () => {
    const hub = open();
    hub.setCalendars({ google: true });
    await hub.readCalendars({
      tenantId: "p1",
      googleEvents: {
        timeZone: "America/New_York",
        items: [
          { id: "g1", status: "confirmed", summary: "Guest", start: { date: "2026-11-12" }, end: { date: "2026-11-14" } },
          { id: "g2", status: "confirmed", summary: "Owner block", start: { date: "2026-11-16" }, end: { date: "2026-11-18" } },
        ],
      },
    });
    expect(hub.stays()).toEqual([
      { checkIn: "2026-11-12", checkout: "2026-11-14", kind: "stay" },
      { checkIn: "2026-11-16", checkout: "2026-11-18", kind: "block" },
    ]);
    const snap = readGoogleCalendarFixture(JSON.stringify({ tenantId: "t", items: [{ id: "g2", summary: "Blocked", start: { date: "2026-11-16" }, end: { date: "2026-11-18" } }] }));
    expect(snap.blocks[0]).toMatchObject({ checkInDate: "2026-11-16", checkoutDate: "2026-11-18" });
  });
});
