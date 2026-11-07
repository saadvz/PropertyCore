import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { savedCalendars } from "../src/hub/calendars";
import { hubFor, resetHubs, type HubGuards } from "../src/hub/hub";
import { hubCalendarCode } from "../src/hub/paths";
import { setCalendarFetch } from "../src/hub/calendarFetch";

/** The property hub: details and calendars in hub.json. Made-up links and a made-up door code only. */

const NOW = new Date("2026-11-07T15:00:00Z");
const AIRBNB = "https://www.airbnb.com/calendar/ical/77.ics?s=abc";
const VRBO = "https://www.vrbo.com/icalendar/abc.ics";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setCalendarFetch(undefined);
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

const BASE = "https://cleaner.example/t/tnt_abcdefghij/p/prp_abcdefghij";

function codeOf(uploadUrl: string): string {
  return uploadUrl.slice(uploadUrl.lastIndexOf("/") + 1);
}

function issued(reply: ReturnType<ReturnType<typeof hubFor>["issueCalendarUpload"]>): string {
  if ("error" in reply) throw new Error(reply.error);
  return codeOf(reply.uploadUrl);
}

describe("hub upload flow", () => {
  it("issues a link whose code is stored only as its hash", () => {
    const { root, hub } = open();
    const reply = hub.issueCalendarUpload({ name: "Airbnb", base: BASE });
    if ("error" in reply) throw new Error(reply.error);
    expect(reply.expiresInMinutes).toBe(10);
    expect(reply.uploadUrl.startsWith(`${BASE}/calendar-link/`)).toBe(true);
    const code = codeOf(reply.uploadUrl);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(root, "hub.json"), "utf8")).not.toContain(code);
    expect(hub.uploadLinkOpen(code)).toEqual({ open: true, name: "Airbnb" });
  });

  it("google: true is saved when the link is issued", () => {
    const { hub } = open();
    hub.issueCalendarUpload({ name: "Airbnb", base: BASE, google: true });
    expect(hub.google()).toBe(true);
  });

  it("a second link replaces the first, from either flow", async () => {
    const { hub } = open();
    const first = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    const second = issued(hub.issueCalendarUpload({ name: "Vrbo", base: "https://cleaner.example/t/tnt_abcdefghij" }));
    expect((await hub.uploadCalendarLink(first, { url: AIRBNB })).status).toBe(404);
    expect((await hub.uploadCalendarLink(second, { url: VRBO })).status).toBe(200);
    expect(hub.calendars().map((c) => c.name)).toEqual(["Vrbo"]);
  });

  it("expired after 10 minutes", async () => {
    let now = NOW;
    const { root, hub } = open(folder(), () => now);
    const code = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    now = new Date(NOW.getTime() + 10 * 60_000);
    expect(hub.uploadLinkOpen(code)).toEqual({ open: false });
    expect((await hub.uploadCalendarLink(code, { url: AIRBNB })).status).toBe(404);
    expect(JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).calendarUpload).toBeUndefined();
  });

  it("refuses a private link with 400 and keeps the link usable", async () => {
    const { hub } = open();
    const code = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    const refused = await hub.uploadCalendarLink(code, { url: "https://10.0.0.8/cal.ics" });
    expect(refused).toEqual({ status: 400, body: { ok: false, error: "Send the calendar's public https link as url." } });
    expect((await hub.uploadCalendarLink(code, { url: AIRBNB })).body).toEqual({ ok: true, message: "Saved the calendar link." });
  });

  it("409 when wouldCancel names cleanings, and nothing saved", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }] });
    hub.useGuards(() => ({ carriesCode: () => false, wouldCancel: async () => ["job-1"] }));
    const code = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    const refused = await hub.uploadCalendarLink(code, { url: VRBO });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Removing that calendar would call off 1 upcoming cleaning. Ask the host, then save again with dropJobs: true.");
    expect(hub.calendars().map((c) => c.url)).toEqual([AIRBNB]);
  });

  it("an upload whose link carries the door code is refused", async () => {
    const { hub } = open();
    hub.useGuards(() => ({ carriesCode: (text) => text.includes("5097"), wouldCancel: noCancel }));
    const code = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    expect((await hub.uploadCalendarLink(code, { url: "https://example.com/5097.ics" })).status).toBe(400);
    expect(hub.calendars()).toEqual([]);
  });

  it("same name replaces only that calendar", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Guesty Lite", url: AIRBNB, legacy: true }, { name: "Vrbo", url: VRBO }] });
    const code = issued(hub.issueCalendarUpload({ name: "guesty lite", base: BASE }));
    expect((await hub.uploadCalendarLink(code, { url: "https://example.com/new.ics" })).status).toBe(200);
    expect(hub.stored()).toEqual([
      { name: "Guesty Lite", url: "https://example.com/new.ics" },
      { name: "Vrbo", url: VRBO },
    ]);
  });

  it("hubCalendarCode accepts all three prefixes", () => {
    const code = "a".repeat(43);
    expect(hubCalendarCode(`/calendar-link/${code}`)).toBe(code);
    expect(hubCalendarCode(`/cleaner-core/calendar-link/${code}`)).toBe(code);
    expect(hubCalendarCode(`/supply/calendar/${code}`)).toBe(code);
    expect(hubCalendarCode(`/calendar-link/${code}x`)).toBeUndefined();
    expect(hubCalendarCode("/photos/abc")).toBeUndefined();
  });

  it("no reply contains the link", async () => {
    const secret = "https://example.com/cal.ics?token=secret-token-xyz";
    const { hub } = open();
    const replies: unknown[] = [];
    const code = issued(hub.issueCalendarUpload({ name: "Airbnb", base: BASE }));
    replies.push(await hub.uploadCalendarLink(code, { url: secret.replace("https://example.com", "https://10.0.0.1") }));
    hub.useGuards(() => ({ carriesCode: () => false, wouldCancel: async () => ["job-1"] }));
    replies.push(await hub.uploadCalendarLink(code, { url: secret }));
    hub.useGuards(() => undefined);
    replies.push(await hub.uploadCalendarLink(code, { url: secret }));
    replies.push(await hub.uploadCalendarLink(code, { url: secret }));
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain("secret-token-xyz");
  });
});

function ics(...stays: [string, string][]): string {
  const events = stays.flatMap(([start, end], i) => ["BEGIN:VEVENT", `UID:stay-${i}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, "SUMMARY:Guest", "END:VEVENT"]);
  return ["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\r\n");
}

/** Serves each link's body; a link not listed fails with 404. */
function serve(bodies: Record<string, string>): void {
  setCalendarFetch(async (url) => ({ status: url in bodies ? 200 : 404, url, async text() { return bodies[url] ?? ""; } }));
}

const googleStay = (start: string, end: string) => ({ timeZone: "America/New_York", items: [{ id: "g1", status: "confirmed", summary: "Guest", start: { date: start }, end: { date: end } }] });

describe("hub calendar reads", () => {
  it("reads every link and returns results per calendar", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }, { name: "Vrbo", url: VRBO }] });
    serve({ [AIRBNB]: ics(["20261110", "20261113"]) });
    const read = await hub.readCalendars({ tenantId: "prop-1" });
    expect(read.links.map((l) => [l.calendar.sourceId, l.read.ok])).toEqual([["ical:airbnb", true], ["ical:vrbo", false]]);
    expect(read.google).toBeUndefined();
    expect(read.googleUnread).toBe(false);
  });

  it("stores checkout dates only when every calendar read", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }, { name: "Vrbo", url: VRBO }] });
    serve({ [AIRBNB]: ics(["20261110", "20261113"]), [VRBO]: ics(["20261120", "20261122"]) });
    await hub.readCalendars({ tenantId: "prop-1" });
    expect(hub.checkouts()).toEqual({ dates: ["2026-11-13", "2026-11-22"], at: NOW.toISOString() });
  });

  it("a failed read keeps the last dates and sets failedAt", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }, { name: "Vrbo", url: VRBO }] });
    serve({ [AIRBNB]: ics(["20261110", "20261113"]), [VRBO]: ics(["20261120", "20261122"]) });
    await hub.readCalendars({ tenantId: "prop-1" });
    serve({ [AIRBNB]: ics(["20261201", "20261203"]) });
    await hub.readCalendars({ tenantId: "prop-1" });
    expect(hub.checkouts()).toEqual({ dates: ["2026-11-13", "2026-11-22"], at: NOW.toISOString(), failedAt: NOW.toISOString() });
  });

  it("google saved but no events keeps the last dates", async () => {
    const { hub } = open();
    hub.setCalendars({ google: true });
    await hub.readCalendars({ tenantId: "prop-1", googleEvents: googleStay("2026-11-05", "2026-11-08") });
    expect(hub.checkouts()?.dates).toEqual(["2026-11-08"]);
    await hub.readCalendars({ tenantId: "prop-1" });
    expect(hub.checkouts()).toMatchObject({ dates: ["2026-11-08"], failedAt: NOW.toISOString() });
  });

  it("google events that read as nothing count as unread", async () => {
    const { hub } = open();
    hub.setCalendars({ google: true });
    const read = await hub.readCalendars({ tenantId: "prop-1", googleEvents: { items: [{ id: "bad" }] } });
    expect(read.googleUnread).toBe(true);
    expect(read.google).toBeUndefined();
    expect(hub.checkouts()).toEqual({ dates: [], failedAt: NOW.toISOString() });
  });

  it("two calendars listing the same checkout count it once", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }, { name: "Vrbo", url: VRBO }] });
    serve({ [AIRBNB]: ics(["20261110", "20261113"]), [VRBO]: ics(["20261111", "20261113"]) });
    await hub.readCalendars({ tenantId: "prop-1" });
    expect(hub.checkouts()?.dates).toEqual(["2026-11-13"]);
  });

  it("google events ignored when google isn't saved", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }] });
    serve({ [AIRBNB]: ics(["20261110", "20261113"]) });
    const read = await hub.readCalendars({ tenantId: "prop-1", googleEvents: googleStay("2026-11-05", "2026-11-08") });
    expect(read.google).toBeUndefined();
    expect(hub.checkouts()?.dates).toEqual(["2026-11-13"]);
  });

  it("nothing saved changes nothing", async () => {
    const { root, hub } = open();
    const read = await hub.readCalendars({ tenantId: "prop-1" });
    expect(read.links).toEqual([]);
    expect(hub.checkouts()).toBeUndefined();
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });
});

describe("final review fixes", () => {
  it("an upload re-checks a calendar list that changed while wouldCancel ran", async () => {
    const { hub } = open();
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }, { name: "Vrbo", url: VRBO }] });
    const checked: string[][] = [];
    let first = true;
    hub.useGuards(() => ({
      carriesCode: () => false,
      wouldCancel: async (claims) => {
        checked.push(claims.map((c) => c.id));
        // A save_sources that drops Vrbo lands while the upload waits for this check.
        if (first) {
          first = false;
          hub.setCalendars({ calendars: [{ name: "Airbnb", url: AIRBNB }] });
        }
        return [];
      },
    }));
    const code = issued(hub.issueCalendarUpload({ name: "Booking", base: BASE }));
    // The save above cleared nothing about the link; re-issue is not needed.
    const saved = await hub.uploadCalendarLink(code, { url: "https://calendar.example/booking.ics" });
    expect(saved.status).toBe(200);
    expect(hub.stored().map((c) => c.name)).toEqual(["Airbnb", "Booking"]);
    expect(checked[checked.length - 1]).toEqual(["ical:airbnb", "ical:booking"]);
  });

  it("an Airbnb link whose listing id passes the card check is saved", () => {
    const { hub } = open();
    const listing = "https://www.airbnb.com/calendar/ical/7349201855637120484.ics?s=abc";
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: listing }] })).toEqual({ ok: true });
    expect(hub.setCalendars({ calendars: [{ name: "Airbnb", url: listing }, { name: "Vrbo", url: VRBO }] })).toEqual({ ok: true });
    // A card number in the query is still refused.
    expect(hub.setCalendars({ calendars: [{ name: "Vrbo", url: `${VRBO}?c=7349201855637120484` }] })).toMatchObject({ ok: false, reason: "card" });
  });

  it("a property nickname or type carrying the door code is refused", () => {
    const { hub } = open();
    hub.useGuards(() => ({ carriesCode: (text) => text.includes("5097"), wouldCancel: noCancel }));
    expect(hub.saveProperty({ nickname: "Unit 5097" })).toMatchObject({ ok: false, reason: "code" });
    expect(hub.saveProperty({ propertyType: "flat 5097" })).toMatchObject({ ok: false, reason: "code" });
    expect(hub.property()).toEqual({});
    expect(hub.saveProperty({ nickname: "Lane House", address: "5097 Scratch Lane" })).toEqual({ ok: true });
  });

  it("without guards, a nickname with 4 digits is refused", () => {
    const { hub } = open();
    expect(hub.saveProperty({ nickname: "Unit 9076" })).toMatchObject({ ok: false, reason: "code" });
  });

  it("an upload link is issued when the base address holds a 4-digit run", () => {
    const { hub } = open();
    // Cleaner Core's full door-code check refuses every 4-digit run while its seal is shut.
    hub.useGuards(() => ({ carriesCode: (text) => /\d{4,}/.test(text), leaks: () => false, wouldCancel: noCancel }));
    const made = hub.issueCalendarUpload({ name: "Airbnb", base: "https://cleaner.example:8443/t/tnt_ab12345678/p/prp_abcdefghij" });
    expect("error" in made).toBe(false);
  });
});
