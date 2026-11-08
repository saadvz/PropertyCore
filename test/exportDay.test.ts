import { describe, expect, it } from "vitest";
import { parseLocalDate } from "../src/operator/auditExport";
import { parseExportDay } from "../src/operator/dayToDay";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import type { LocalDate } from "../src/core/timezone";
import { grokHarness } from "./grokHarness";

const today: LocalDate = { year: 2026, month: 9, day: 28 };
const UNREADABLE = "I couldn't read that date. Which day? Say today or a date like Sept 28.";

const read = (input: string) => parseExportDay(input, today);

describe("export_records day parser", () => {
  it("reads today, yesterday, and a YYYY-MM-DD through parseLocalDate", () => {
    expect(read("today")).toEqual({ ok: true });
    expect(read("TODAY")).toEqual({ ok: true });
    expect(read(" yesterday ")).toEqual({ ok: true, day: { year: 2026, month: 9, day: 27 } });
    expect(read("2026-09-28")).toEqual({ ok: true, day: { year: 2026, month: 9, day: 28 } });
    expect(read("2027-03-15")).toEqual({ ok: true, day: { year: 2027, month: 3, day: 15 } });
    expect(parseLocalDate("2027-03-15")).toEqual({ year: 2027, month: 3, day: 15 });
    expect(parseLocalDate("Sept 28")).toBeUndefined();
    expect(parseLocalDate("2026-02-30")).toEqual({ year: 2026, month: 2, day: 30 });
  });

  it("reads a month and day, including Sept, as the most recent past one", () => {
    const sep28 = { ok: true, day: { year: 2026, month: 9, day: 28 } };
    expect(read("Sep 28")).toEqual(sep28);
    expect(read("Sept 28")).toEqual(sep28);
    expect(read("September 28")).toEqual(sep28);
    expect(read("sept. 28")).toEqual(sep28);
    expect(read("9/28")).toEqual(sep28);
    expect(read("Oct 8")).toEqual({ ok: true, day: { year: 2025, month: 10, day: 8 } });
    expect(read("10/8")).toEqual({ ok: true, day: { year: 2025, month: 10, day: 8 } });
    expect(read("Dec 1")).toEqual({ ok: true, day: { year: 2025, month: 12, day: 1 } });
  });

  it("reads Feb 29 with no year as the most recent past Feb 29", () => {
    expect(read("Feb 29")).toEqual({ ok: true, day: { year: 2024, month: 2, day: 29 } });
    expect(read("2/29")).toEqual({ ok: true, day: { year: 2024, month: 2, day: 29 } });
    expect(parseExportDay("Feb 29", { year: 2028, month: 2, day: 29 })).toEqual({ ok: true, day: { year: 2028, month: 2, day: 29 } });
    expect(parseExportDay("Feb 29", { year: 2028, month: 2, day: 28 })).toEqual({ ok: true, day: { year: 2024, month: 2, day: 29 } });
    expect(read("Feb 30")).toEqual({ ok: false });
    expect(read("2/30")).toEqual({ ok: false });
  });

  it("rejects an impossible day", () => {
    expect(read("Feb 30")).toEqual({ ok: false });
    expect(read("13/5")).toEqual({ ok: false });
    expect(read("not a day")).toEqual({ ok: false });
    expect(read("2026-02-30")).toEqual({ ok: false });
  });
});

describe("export_records tells the landlord when a day is unreadable", () => {
  it("uses the Sept 28 line for Feb 30, 13/5, and garbage, and keeps a future YYYY-MM-DD", async () => {
    const exportRecords = OPERATOR_TOOLS.find((item) => item.name === "export_records");
    expect(exportRecords?.description).toContain(
      "Day is today (default), yesterday, YYYY-MM-DD, a month and day like Sept 28, or M/D. A month and day with no year means the most recent past one.",
    );
    const exportAudit = OPERATOR_TOOLS.find((item) => item.name === "export_audit");
    expect(exportAudit?.description).toContain('Day is "today" (default) or YYYY-MM-DD.');

    const h = grokHarness();
    try {
      const propertyId = await h.setUpAlfredWay();
      const dayOf = async (day: string) => {
        const out = await h.ok("export_records", { property: propertyId, day });
        return String(out.reference).match(/\d{4}-\d{2}-\d{2}/)?.[0];
      };
      expect(await dayOf("today")).toBe("2026-09-28");
      expect(await dayOf("yesterday")).toBe("2026-09-27");
      expect(await dayOf("2026-09-28")).toBe("2026-09-28");
      expect(await dayOf("Sept 28")).toBe("2026-09-28");
      expect(await dayOf("9/28")).toBe("2026-09-28");
      expect(await dayOf("Oct 8")).toBe("2025-10-08");
      expect(await dayOf("2027-03-15")).toBe("2027-03-15");

      for (const day of ["Feb 30", "13/5", "not a day"]) {
        const blocked = await h.ok("export_records", { property: propertyId, day });
        expect(blocked).toMatchObject({ status: "blocked", message: UNREADABLE });
        expect(blocked.checksumCovers).toBeUndefined();
      }

      const futureAudit = await h.ok("export_audit", { property: propertyId, day: "2027-03-15" });
      expect(String(futureAudit.reference)).toContain("2027-03-15");
      expect(await h.fails("export_audit", { property: propertyId, day: "Sept 28" })).toBe('Use "today" or a date like 2026-09-28.');
    } finally {
      h.cleanup();
    }
  });
});
