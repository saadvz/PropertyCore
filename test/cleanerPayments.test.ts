import { describe, expect, it } from "vitest";
import { dollarsText, nextReminderAt, payCents, venmoPayLink, venmoProfileLink, venmoUsername } from "../src/cleaner-core/payments";

describe("venmoUsername", () => {
  it("drops one @ and keeps a valid username", () => {
    expect(venmoUsername("@scratch-cleaner")).toBe("scratch-cleaner");
    expect(venmoUsername(" scratch_cleaner ")).toBe("scratch_cleaner");
  });

  it("refuses short, long, all-digit, phone, and email values", () => {
    for (const bad of ["abcd", "a".repeat(31), "5555550101", "+15555550101", "scratch@example.com", "@@scratch-cleaner", "scratch cleaner", "555-555-0101", "1-555-555-0101", "555_555_0101"]) {
      expect(venmoUsername(bad)).toBeUndefined();
    }
  });
});

describe("payCents and dollarsText", () => {
  it("stores whole cents within $1 to $1,000", () => {
    expect(payCents(85)).toBe(8500);
    expect(payCents(85.5)).toBe(8550);
    expect(payCents(1)).toBe(100);
    expect(payCents(1000)).toBe(100000);
    for (const bad of [0.99, 1000.01, Number.NaN, Infinity, -5]) expect(payCents(bad)).toBeUndefined();
  });

  it("formats dollars", () => {
    expect(dollarsText(8500)).toBe("$85.00");
    expect(dollarsText(100000)).toBe("$1,000.00");
  });
});

describe("links", () => {
  it("builds the exact pay link", () => {
    expect(venmoPayLink({ username: "scratch-cleaner", cents: 8500, label: "Lake House", day: "Oct 30" })).toBe(
      "https://venmo.com/scratch-cleaner?txn=pay&amount=85.00&audience=private&note=Lake+House+cleaning+Oct+30",
    );
    expect(venmoPayLink({ username: "scratch-cleaner", cents: 100000, label: "Lake House", day: "Oct 30" })).toContain("amount=1000.00");
  });

  it("builds the profile link", () => {
    expect(venmoProfileLink("scratch-cleaner")).toBe("https://venmo.com/u/scratch-cleaner");
  });
});

describe("nextReminderAt", () => {
  it("is 9:00 local the next day", () => {
    expect(nextReminderAt("2026-10-30T18:40:00.000Z", "America/New_York")).toBe("2026-10-31T13:00:00.000Z");
  });

  it("crosses the daylight-saving change (Nov 1, 2026 in New York)", () => {
    expect(nextReminderAt("2026-10-31T18:00:00.000Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
  });

  it("uses the property's own date, not UTC's", () => {
    // 11:30 PM Oct 30 in Los Angeles is already Oct 31 in UTC.
    expect(nextReminderAt("2026-10-31T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-10-31T16:00:00.000Z");
  });
});
