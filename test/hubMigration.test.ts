import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { emptySupply, type SupplyFile } from "../src/supply-core/store";

/** Moving a property's details and calendars out of cleaner-live.json and supply.json into hub.json. */

const NOW = new Date("2026-11-07T15:00:00Z");
const AIRBNB = "https://www.airbnb.com/calendar/ical/77.ics?s=abc";
const VRBO = "https://www.vrbo.com/icalendar/abc.ics";
const GUESTY = "https://app.guesty.com/api/public/icalendar-dashboard-api/export/abc";
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-move-"));
  roots.push(root);
  return root;
}

const read = (root: string, name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as Record<string, unknown>;

function cleaner(root: string, fields: Record<string, unknown>): void {
  writeFileSync(join(root, "cleaner-live.json"), `${JSON.stringify({ choice: "cleaners", business: "Scratch Stays", host: "+15555550100", ...fields })}\n`);
}

function supply(root: string, change: (file: SupplyFile) => void): void {
  const file = emptySupply();
  change(file);
  writeFileSync(join(root, "supply.json"), `${JSON.stringify(file)}\n`);
}

const open = (root: string, cleaningInUse?: boolean) => hubFor(root, { now: () => NOW, ...(cleaningInUse === undefined ? {} : { migrate: { cleaningInUse } }) });

const CLEANER_PLACE = {
  nickname: "Lane House",
  address: "12 Scratch Lane, Testville",
  propertyType: "house",
  timeZone: "America/New_York",
  checkoutTime: "10:00",
  checkInTime: "16:00",
};

describe("moving data into hub.json", () => {
  it("moves Cleaner Core's details and calendars", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE, calendars: [{ name: "Airbnb", url: AIRBNB }], google: true, sourcesDone: true });
    const hub = open(root);
    expect(hub.property()).toEqual(CLEANER_PLACE);
    expect(hub.stored()).toEqual([{ name: "Airbnb", url: AIRBNB }]);
    expect(hub.google()).toBe(true);
    expect(hub.calendarsDone()).toBe(true);
    const left = read(root, "cleaner-live.json");
    for (const key of [...Object.keys(CLEANER_PLACE), "calendars", "google", "sourcesDone"]) expect(left).not.toHaveProperty(key);
    expect(left).toMatchObject({ business: "Scratch Stays", host: "+15555550100" });
  });

  it("Cleaner Core's details win; Supply Core fills the gaps", () => {
    const root = folder();
    cleaner(root, { address: "12 Scratch Lane, Testville", checkoutTime: "10:00" });
    supply(root, (f) => {
      f.settings.property = { name: "Supply Name", address: "99 Other Road", timeZone: "America/Chicago" };
    });
    const hub = open(root);
    // Cleaner Core saved its property, so a nickname it never set stays unset and its texts read the same.
    expect(hub.property()).toEqual({ address: "12 Scratch Lane, Testville", checkoutTime: "10:00", timeZone: "America/Chicago" });
    expect((read(root, "supply.json").settings as Record<string, unknown>).property).toBeUndefined();
  });

  it("only Supply Core saved a property: its name becomes the nickname", () => {
    const root = folder();
    supply(root, (f) => {
      f.settings.property = { name: "Court Flat", address: "8 Scratch Court", timeZone: "America/Denver" };
    });
    expect(open(root).property()).toEqual({ nickname: "Court Flat", address: "8 Scratch Court", timeZone: "America/Denver" });
  });

  it("only Supply Core has calendars: the hub takes them", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE });
    supply(root, (f) => {
      f.sources = [{ name: "Vrbo", kind: "ical", url: VRBO }, { name: "Google Calendar", kind: "google-calendar" }];
      f.setup.sourcesDone = true;
    });
    const hub = open(root);
    expect(hub.stored()).toEqual([{ name: "Vrbo", url: VRBO }]);
    expect(hub.google()).toBe(true);
    expect(hub.calendarsDone()).toBe(true);
    expect(read(root, "supply.json").sources).toBeUndefined();
  });

  it("both have calendars, cleaning on: Cleaner Core's list, Supply's extra set aside", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE, calendars: [{ name: "Airbnb", url: AIRBNB }] });
    supply(root, (f) => {
      f.sources = [{ name: "Airbnb copy", kind: "ical", url: AIRBNB }, { name: "Vrbo", kind: "ical", url: VRBO }, { name: "Google Calendar", kind: "google-calendar" }];
    });
    const hub = open(root, true);
    expect(hub.stored()).toEqual([{ name: "Airbnb", url: AIRBNB }]);
    // Google from the losing side would start Cleaner Core waiting for Google events, so it is set aside too.
    expect(hub.google()).toBe(false);
    expect(hub.setAside()).toEqual(["Vrbo", "Google Calendar"]);
  });

  it("both have calendars, cleaning off: Supply Core's list wins", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE, calendars: [{ name: "Airbnb", url: AIRBNB }], sourcesDone: true });
    supply(root, (f) => {
      f.sources = [{ name: "Vrbo", kind: "ical", url: VRBO }];
    });
    const hub = open(root, false);
    expect(hub.stored()).toEqual([{ name: "Vrbo", url: VRBO }]);
    expect(hub.setAside()).toEqual(["Airbnb"]);
    expect(hub.calendarsDone()).toBe(false);
  });

  it("the legacy link moves with legacy: true", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE, calendarLink: GUESTY, calendars: [{ name: "Airbnb", url: AIRBNB }] });
    const hub = open(root);
    expect(hub.stored()).toEqual([{ name: "Guesty Lite", url: GUESTY, legacy: true }, { name: "Airbnb", url: AIRBNB }]);
    expect(hub.calendars().map((c) => c.sourceId)).toEqual(["guesty-lite", "ical:airbnb"]);
    expect(read(root, "cleaner-live.json")).not.toHaveProperty("calendarLink");
  });

  it("Cleaner Core's pending upload moves; Supply Core's is dropped", () => {
    const root = folder();
    const pending = { hash: "a".repeat(64), expiresAt: "2026-11-07T15:05:00.000Z", name: "Airbnb", by: { assistant: "grok" } };
    cleaner(root, { ...CLEANER_PLACE, calendarUpload: pending });
    supply(root, (f) => {
      f.calendarUpload = { hash: "b".repeat(64), name: "Vrbo", expiresAt: "2026-11-07T15:06:00.000Z" };
    });
    open(root);
    expect(read(root, "hub.json").calendarUpload).toEqual(pending);
    expect(read(root, "supply.json").calendarUpload).toBeUndefined();
    expect(read(root, "cleaner-live.json").calendarUpload).toBeUndefined();
  });

  it("Supply Core's last checkouts move", () => {
    const root = folder();
    supply(root, (f) => {
      f.checkouts = { dates: ["2026-11-13"], at: "2026-11-06T10:00:00.000Z" };
    });
    expect(open(root).checkouts()).toEqual({ dates: ["2026-11-13"], at: "2026-11-06T10:00:00.000Z" });
    expect(read(root, "supply.json").checkouts).toBeUndefined();
  });

  it("a crash after hub.json is written is finished by the next open", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE, calendars: [{ name: "Airbnb", url: AIRBNB }] });
    supply(root, (f) => {
      f.sources = [{ name: "Vrbo", kind: "ical", url: VRBO }];
    });
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { address: "From hub" }, calendars: [{ name: "Airbnb", url: AIRBNB }] }));
    const hub = open(root);
    // hub.json is the record once it exists: nothing is merged in again.
    expect(hub.property()).toEqual({ address: "From hub" });
    expect(hub.setAside()).toEqual([]);
    expect(read(root, "cleaner-live.json")).not.toHaveProperty("calendars");
    expect(read(root, "cleaner-live.json")).not.toHaveProperty("address");
    expect(read(root, "supply.json").sources).toBeUndefined();
  });

  it("a folder with nothing to move writes no hub.json", () => {
    const root = folder();
    cleaner(root, {});
    open(root);
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });

  it("a second open moves nothing again", () => {
    const root = folder();
    cleaner(root, { ...CLEANER_PLACE });
    open(root);
    resetHubs();
    cleaner(root, { address: "Written later by an old desk" });
    expect(open(root).property().address).toBe(CLEANER_PLACE.address);
  });

  it.todo("a desk opened after the move never writes calendars back");
});

describe("moving every property at startup", () => {
  it("migrateHubs uses each property's cleaning switch", async () => {
    const { migrateHubs } = await import("../src/hosted/hubStartup");
    const dataRoot = folder();
    const flows = (cleaning: boolean) => ({ cleaning: { on: cleaning }, supplies: { on: true }, fixer: { on: false } });
    const on = { id: "prp_aaaaaaaaaa", label: "Lane", createdAt: NOW.toISOString(), flows: flows(true) };
    const off = { id: "prp_bbbbbbbbbb", label: "Court", createdAt: NOW.toISOString(), flows: flows(false) };
    const tenant = { id: "tnt_cccccccccc", properties: [on, off] };
    for (const property of [on, off]) {
      const root = join(dataRoot, "tenants", tenant.id, "properties", property.id);
      mkdirSync(root, { recursive: true });
      cleaner(root, { ...CLEANER_PLACE, calendars: [{ name: "Airbnb", url: AIRBNB }] });
      supply(root, (f) => {
        f.sources = [{ name: "Vrbo", kind: "ical", url: VRBO }];
      });
    }
    migrateHubs(dataRoot, [tenant as never], () => NOW);
    resetHubs();
    const hubOf = (id: string) => hubFor(join(dataRoot, "tenants", tenant.id, "properties", id), { now: () => NOW });
    expect(hubOf(on.id).stored()).toEqual([{ name: "Airbnb", url: AIRBNB }]);
    expect(hubOf(off.id).stored()).toEqual([{ name: "Vrbo", url: VRBO }]);
  });
});
