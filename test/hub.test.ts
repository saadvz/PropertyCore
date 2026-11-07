import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { savedCalendars } from "../src/hub/calendars";
import { hubFor, resetHubs, type HubGuards } from "../src/hub/hub";

/** The property hub: details and calendars in hub.json. Made-up links and a made-up door code only. */

const NOW = new Date("2026-11-07T15:00:00Z");
const AIRBNB = "https://www.airbnb.com/calendar/ical/77.ics?s=abc";
const VRBO = "https://www.vrbo.com/icalendar/abc.ics";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-"));
  roots.push(root);
  return root;
}

function open(root = folder(), now = () => NOW) {
  return { root, hub: hubFor(root, { now }) };
}

const noCancel: HubGuards["wouldCancel"] = async () => [];

describe("hub store", () => {
  it("saves and reloads property details", () => {
    const { root, hub } = open();
    hub.saveProperty({ nickname: "Lane House", address: "12 Scratch Lane, Testville", timeZone: "America/New_York", checkoutTime: "10:00", checkInTime: "16:00" });
    resetHubs();
    const again = hubFor(root, { now: () => NOW });
    expect(again.property()).toEqual({ nickname: "Lane House", address: "12 Scratch Lane, Testville", timeZone: "America/New_York", checkoutTime: "10:00", checkInTime: "16:00" });
    expect(JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).schemaVersion).toBe(1);
  });

  it("an unsaved folder reads empty and writes nothing", () => {
    const { root, hub } = open();
    expect(hub.property()).toEqual({});
    expect(hub.calendars()).toEqual([]);
    expect(hub.google()).toBe(false);
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });

  it("keeps the legacy link's source id", () => {
    const saved = savedCalendars([
      { name: "Guesty Lite", url: AIRBNB, legacy: true },
      { name: "Airbnb", url: VRBO },
    ]);
    expect(saved.map((c) => c.sourceId)).toEqual(["guesty-lite", "ical:airbnb"]);
    expect(saved[0]!.origin).toMatch(/^[0-9a-f]{16}$/);
  });

  it("slugs match Cleaner Core's", () => {
    const saved = savedCalendars([
      { name: "Airbnb", url: AIRBNB },
      { name: "airbnb!", url: VRBO },
    ]);
    expect(saved.map((c) => c.sourceId)).toEqual(["ical:airbnb", "ical:airbnb-2"]);
  });

  it("saves calendars, google and done", () => {
    const { hub } = open();
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }], google: true, done: true })).toEqual({ ok: true });
    expect(hub.calendars().map((c) => c.name)).toEqual(["Airbnb"]);
    expect(hub.google()).toBe(true);
    expect(hub.calendarsDone()).toBe(true);
    expect(hub.claims().map((c) => c.id)).toEqual(["ical:airbnb", "google-calendar"]);
  });

  it("refuses masked, private and card links", () => {
    const { hub } = open();
    const masked = hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://www.airbnb.com/calendar/ical/[REDACTED]" }] });
    expect(masked).toMatchObject({ ok: false, reason: "masked" });
    const local = hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://192.168.1.4/cal.ics" }] });
    expect(local).toMatchObject({ ok: false, reason: "private" });
    const card = hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://example.com/cal.ics?c=4111 1111 1111 1111" }] });
    expect(card).toMatchObject({ ok: false, reason: "card" });
    expect(hub.calendars()).toEqual([]);
  });

  it("refuses more than 8 calendars", () => {
    const { hub } = open();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Cal ${String.fromCharCode(97 + i)}`, url: `https://example.com/${i}.ics` }));
    expect(hub.setCalendars({ calendars: nine })).toMatchObject({ ok: false, error: "I can keep up to 8 calendar links." });
  });

  it("with guards, carriesCode refuses a name or link", () => {
    const { hub } = open();
    hub.useGuards(() => ({ carriesCode: (text) => text.includes("5097"), wouldCancel: noCancel }));
    expect(hub.setCalendars({ calendars: [{ name: "Lock 5097", url: AIRBNB }] })).toMatchObject({ ok: false, reason: "code" });
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://example.com/5097.ics" }] })).toMatchObject({ ok: false, reason: "code" });
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }] })).toEqual({ ok: true });
  });

  it("without guards, a name with 4 digits is refused", () => {
    const { hub } = open();
    expect(hub.setCalendars({ calendars: [{ name: "Unit 9076", url: AIRBNB }] })).toMatchObject({ ok: false, reason: "code" });
    expect(hub.setCalendars({ calendars: [{ name: "Unit 12", url: AIRBNB }] })).toEqual({ ok: true });
  });

  it("setCalendars never calls wouldCancel", () => {
    const { hub } = open();
    hub.useGuards(() => ({
      carriesCode: () => false,
      wouldCancel: () => {
        throw new Error("wouldCancel called");
      },
    }));
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }] })).toEqual({ ok: true });
  });

  it("a save clears the set-aside list", () => {
    const root = folder();
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: {}, calendars: [], calendarsSetAside: [{ name: "Vrbo", url: VRBO }] }));
    const { hub } = open(root);
    expect(hub.setAside()).toEqual(["Vrbo"]);
    hub.setCalendars({ done: true });
    expect(hub.setAside()).toEqual([]);
  });
});
