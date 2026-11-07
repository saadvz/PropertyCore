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

/** supply.json as Supply Core wrote it before the hub: its own property, calendars and checkouts. */
type OldSupply = Omit<SupplyFile, "settings" | "setup"> & {
  settings: SupplyFile["settings"] & { property?: { name: string; address: string; timeZone: string } };
  setup: SupplyFile["setup"] & { sourcesDone?: boolean };
  sources?: { name: string; kind: "ical" | "google-calendar"; url?: string }[];
  calendarUpload?: { hash: string; name: string; expiresAt: string };
  checkouts?: { dates: string[]; at?: string; failedAt?: string };
};

function supply(root: string, change: (file: OldSupply) => void): void {
  const file: OldSupply = emptySupply();
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

describe("startup with a bad property folder", () => {
  it("one unreadable property is logged and skipped; the others still move", async () => {
    const { migrateHubs } = await import("../src/hosted/hubStartup");
    const dataRoot = folder();
    const flows = { cleaning: { on: true }, supplies: { on: false }, fixer: { on: false } };
    const bad = { id: "prp_aaaaaaaaaa", label: "Lane", createdAt: NOW.toISOString(), flows };
    const good = { id: "prp_bbbbbbbbbb", label: "Court", createdAt: NOW.toISOString(), flows };
    const tenant = { id: "tnt_cccccccccc", properties: [bad, good] };
    const rootOf = (id: string) => join(dataRoot, "tenants", tenant.id, "properties", id);
    mkdirSync(rootOf(bad.id), { recursive: true });
    writeFileSync(join(rootOf(bad.id), "cleaner-live.json"), "{ not json");
    mkdirSync(rootOf(good.id), { recursive: true });
    cleaner(rootOf(good.id), { ...CLEANER_PLACE });
    const logs: string[] = [];
    expect(() => migrateHubs(dataRoot, [tenant as never], () => NOW, (line) => logs.push(line))).not.toThrow();
    expect(logs).toEqual([`Couldn't move ${tenant.id}/${bad.id} into its hub; it will try again when it opens.`]);
    expect(existsSync(join(rootOf(good.id), "hub.json"))).toBe(true);
  });
});

describe("moving the door code into door-access.json", () => {
  const SEAL = { iv: "aXYtaXYtaXYtaXY=", tag: "dGFnLXRhZy10YWctdGFnLQ==", data: "ZGF0YQ==" };
  const UPLOAD = { hash: "a".repeat(64), expiresAt: "2026-11-07T15:10:00.000Z", lockLocation: "back door" };
  const door = (root: string) => read(root, "door-access.json");

  it("moves the seal byte for byte", () => {
    const root = folder();
    cleaner(root, { pinSeal: SEAL, lockLocation: "back door", doorCodeUpload: UPLOAD, doorCodeTo: "cleaner" });
    open(root);
    expect(door(root)).toEqual({ schemaVersion: 1, pinSeal: SEAL, lockLocation: "back door", upload: UPLOAD });
    const left = read(root, "cleaner-live.json");
    expect(left.pinSeal).toBeUndefined();
    expect(left.lockLocation).toBeUndefined();
    expect(left.doorCodeUpload).toBeUndefined();
    expect(left.doorCodeTo).toBe("cleaner");
  });

  it("moves the seal even when hub.json already exists", () => {
    const root = folder();
    writeFileSync(join(root, "hub.json"), `${JSON.stringify({ schemaVersion: 1, property: { address: "12 Scratch Lane" }, calendars: [] })}\n`);
    cleaner(root, { pinSeal: SEAL, lockLocation: "back door" });
    open(root);
    expect(door(root)).toMatchObject({ pinSeal: SEAL, lockLocation: "back door" });
    expect(read(root, "cleaner-live.json").pinSeal).toBeUndefined();
    expect(read(root, "hub.json").property).toEqual({ address: "12 Scratch Lane" });
  });

  it("a crash after door-access.json is written: the next open finishes", () => {
    const root = folder();
    writeFileSync(join(root, "door-access.json"), `${JSON.stringify({ schemaVersion: 1, pinSeal: SEAL })}\n`);
    cleaner(root, { pinSeal: SEAL });
    open(root);
    expect(door(root)).toEqual({ schemaVersion: 1, pinSeal: SEAL });
    expect(read(root, "cleaner-live.json").pinSeal).toBeUndefined();
  });

  it("door-access.json is the record", () => {
    const root = folder();
    const newer = { ...SEAL, data: "bmV3ZXI=" };
    writeFileSync(join(root, "door-access.json"), `${JSON.stringify({ schemaVersion: 1, pinSeal: newer })}\n`);
    cleaner(root, { pinSeal: SEAL, lockLocation: "old gate" });
    open(root);
    expect(door(root)).toEqual({ schemaVersion: 1, pinSeal: newer });
  });

  it("a folder with no door code writes no door-access.json", () => {
    const root = folder();
    cleaner(root, { address: "12 Scratch Lane", doorCodeTo: "group" });
    open(root);
    expect(existsSync(join(root, "door-access.json"))).toBe(false);
  });
});
