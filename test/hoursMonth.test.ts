import { afterEach, describe, expect, it } from "vitest";
import { buildMonth } from "../src/hours-log/month";
import { DEFAULT_COLUMNS, sheetRows } from "../src/hours-log/sheet";
import { readRecords } from "../src/hours-log/sources";
import { checkSettings, readHours, writeHours } from "../src/hours-log/store";
import { emptyFolder, engine, octoberFolder, type Fixture } from "./hoursFixture";

/** #238: a month of rows in the host's columns, with what needs the host, and the checkouts reconciled. */

let open: Fixture | undefined;
afterEach(() => {
  open?.cleanup();
  open = undefined;
});

function october(settings = {}) {
  open = octoberFolder();
  return buildMonth(readRecords(open.root), "2026-10", settings);
}

describe("a month's rows", () => {
  it("has the issue's twelve columns, in local time at the property", () => {
    const row = october().rows.find((r) => r.reference === "Cleaner Core job job_oct4");
    expect(row).toMatchObject({
      date: "2026-10-04",
      start: "11:05",
      end: "13:35",
      property: "Scratch Lane",
      participant: "Ana",
      code: "CLN-1",
      category: "Cleaning and turnover",
      activity: "Turnover cleaning",
      task: "Turnover cleaning after the 2026-10-04 checkout",
      where: "On site",
      hours: 2.5,
    });
  });

  it("puts a record by its local date: 12:30 AM UTC on Oct 1 is still September in New York", () => {
    open = emptyFolder();
    open.write("hub.json", { schemaVersion: 1, property: { nickname: "Scratch Lane", timeZone: "America/New_York" }, calendars: [] });
    open.write("supply.json", { settings: {}, setup: {}, items: [], draft: [], orders: [{ id: "ord_edge", at: "2026-10-01T00:30:00.000Z", store: "Example Mart", items: [], totalCents: 100, chargedCents: 100, source: "host", approvedBy: "host-browser", status: "placed" }], carts: [], lowReports: [] });
    const records = readRecords(open.root);
    expect(buildMonth(records, "2026-10", {}).rows).toEqual([]);
    expect(buildMonth(records, "2026-09", {}).rows.map((r) => [r.date, r.start])).toEqual([["2026-09-30", "20:30"]]);
  });

  it("leaves out other months", () => {
    expect(october().rows.some((r) => r.reference.includes("ord_sept"))).toBe(false);
  });

  it("gives owner rows 0 hours until the host sets minutes for the code, and says which codes", () => {
    const month = october();
    const owner = month.rows.filter((r) => r.log === "owner");
    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((r) => r.hours === 0)).toBe(true);
    expect(owner.every((r) => r.participant === "Sam")).toBe(true);
    expect(month.needs).toContainEqual(expect.stringContaining("REP-2"));
  });

  it("times an owner row with the host's own minutes for its code", () => {
    const month = october({ codes: [{ code: "REP-2", group: "Repairs and upkeep", activity: "Approve a repair", minutes: 15 }] });
    const go = month.rows.find((r) => r.kind === "approve-repair");
    expect(go).toMatchObject({ start: "10:00", end: "10:15", hours: 0.25, activity: "Approve a repair", where: "Remote" });
    expect(month.needs.some((line) => line.includes("REP-2"))).toBe(false);
  });

  it("uses the host's own code for a row kind, and the owner name they set", () => {
    const month = october({ codes: [{ code: "T-9", group: "Travel and site", activity: "Supplies", minutes: 5 }], kindCodes: { "place-order": "T-9" }, ownerName: "Sam Rivera" });
    const own = month.rows.find((r) => r.kind === "place-order");
    expect(own).toMatchObject({ code: "T-9", category: "Travel and site", participant: "Sam Rivera", hours: 0.08 });
  });

  it("keeps Property Core's own work at 0 hours, in its own log", () => {
    const system = october().rows.filter((r) => r.log === "property-core");
    expect(system.map((r) => r.kind).sort()).toEqual(["auto-order", "auto-order", "record-payment"]);
    expect(system.every((r) => r.hours === 0 && r.participant === "Property Core")).toBe(true);
  });

  it("splits the rows into one log per person: owner, cleaner, each pro, and Property Core", () => {
    const logs = october().logs;
    expect(logs.map((l) => [l.log, l.name])).toEqual([
      ["owner", "Sam"],
      ["cleaner", "Ana"],
      ["pro:pro_drip", "Drip Plumbing"],
      ["property-core", "Property Core"],
    ]);
    expect(logs.find((l) => l.log === "cleaner")?.hours).toBe(4.5);
  });

  it("lists a cleaning with no START for the host's review", () => {
    expect(october().needs).toContainEqual(expect.stringContaining("2026-10-12"));
  });
});

describe("reconciling to the booking calendar", () => {
  it("lists each checkout in the month with no cleaning row; a block isn't a checkout", () => {
    const { reconcile } = october();
    expect(reconcile.checkouts).toEqual(["2026-10-04", "2026-10-12", "2026-10-25"]);
    expect(reconcile.unmatched).toEqual(["2026-10-25"]);
    expect(reconcile.lockEvents).toEqual({ status: "no-lock" });
  });
});

describe("rebuilding", () => {
  it("gives the same fingerprint every time, and a new one when a record changes", () => {
    const first = october();
    expect(buildMonth(readRecords(open!.root), "2026-10", {}).fingerprint).toBe(first.fingerprint);
    open!.write("cleaner-job/cleaner-core.json", { ...engine, jobs: engine.jobs.map((j) => (j.id === "job_oct4" ? { ...j, doneAt: "2026-10-04T18:00:00.000Z" } : j)) });
    expect(buildMonth(readRecords(open!.root), "2026-10", {}).fingerprint).not.toBe(first.fingerprint);
  });

  it("an empty month has no rows and no error", () => {
    open = emptyFolder();
    const month = buildMonth(readRecords(open.root), "2026-10", {});
    expect(month.rows).toEqual([]);
    expect(month.logs).toEqual([]);
  });
});

describe("the Sheet", () => {
  it("writes the default columns with their headers first", () => {
    const rows = sheetRows(october().rows.filter((r) => r.reference === "Cleaner Core job job_oct4"), DEFAULT_COLUMNS);
    expect(rows[0]).toEqual(["Date", "Start", "End", "Property", "Participant", "Activity code", "Category", "Activity", "Task", "Supporting reference", "On site or remote", "Hours"]);
    expect(rows[1]).toEqual(["2026-10-04", "11:05", "13:35", "Scratch Lane", "Ana", "CLN-1", "Cleaning and turnover", "Turnover cleaning", "Turnover cleaning after the 2026-10-04 checkout", "Cleaner Core job job_oct4", "On site", "2.50"]);
  });

  it("follows the host's own order and headers", () => {
    const rows = sheetRows(october().rows.filter((r) => r.reference === "Cleaner Core job job_oct4"), [
      { field: "hours", header: "Hrs" },
      { field: "date", header: "Day" },
    ]);
    expect(rows).toEqual([
      ["Hrs", "Day"],
      ["2.50", "2026-10-04"],
    ]);
  });
});

describe("settings", () => {
  it("are saved in hours.json and never hold rows", () => {
    open = emptyFolder();
    writeHours(open.root, { settings: { ownerName: "Sam" }, months: {} });
    expect(readHours(open.root)).toEqual({ settings: { ownerName: "Sam" }, months: {} });
  });

  it("refuse an unknown column, a row kind mapped to a missing code, or minutes out of range", () => {
    expect(checkSettings({ columns: [{ field: "phone" as "date", header: "Phone" }] })).toContain("phone");
    expect(checkSettings({ kindCodes: { cleaning: "NOPE" } })).toContain("NOPE");
    expect(checkSettings({ codes: [{ code: "A", group: "G", activity: "X", minutes: 900 }] })).toContain("minutes");
    expect(checkSettings({ codes: [{ code: "A", group: "G", activity: "X", minutes: 5 }], kindCodes: { cleaning: "A" } })).toBeUndefined();
  });
});

describe("review of #238", () => {
  it("0 minutes the host chose is not 'not set'", () => {
    const month = october({ codes: [{ code: "REP-2", group: "Repairs and upkeep", activity: "Approve", minutes: 0 }] });
    expect(month.needs.some((line) => line.includes("REP-2"))).toBe(false);
  });

  it("the fingerprint changes when the host changes the columns", () => {
    const first = october().fingerprint;
    expect(buildMonth(readRecords(open!.root), "2026-10", { columns: [{ field: "date", header: "Day" }] }).fingerprint).not.toBe(first);
  });
});
