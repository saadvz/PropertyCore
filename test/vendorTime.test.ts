import { describe, expect, it } from "vitest";
import { parseVendorTime } from "../src/fixer-core/vendorTime";

/** A vendor's new time in their own words (#237). Proposed visit: Tue 12 Jan 2027, 9 to 11, New York. */
const TZ = "America/New_York";
const ANCHOR = "2027-01-12T14:00:00.000Z";
const at = (text: string) => parseVendorTime(text, { anchor: ANCHOR, timeZone: TZ });

describe("parseVendorTime", () => {
  it("reads a weekday and a range, 1 to 6 as PM", () => {
    expect(at("Can we do Thursday 1 to 3 instead?")).toEqual({ from: "2027-01-14T18:00:00.000Z", until: "2027-01-14T20:00:00.000Z" });
  });

  it("reads 7 to 11 as AM, and explicit am/pm and minutes", () => {
    expect(at("thu 8-10")).toEqual({ from: "2027-01-14T13:00:00.000Z", until: "2027-01-14T15:00:00.000Z" });
    expect(at("Friday 10:30am - 12:30pm")).toEqual({ from: "2027-01-15T15:30:00.000Z", until: "2027-01-15T17:30:00.000Z" });
  });

  it("reads a month and day, and m/d", () => {
    expect(at("Jan 19, 9 to 11")).toEqual({ from: "2027-01-19T14:00:00.000Z", until: "2027-01-19T16:00:00.000Z" });
    expect(at("1/19 9-11am")).toEqual({ from: "2027-01-19T14:00:00.000Z", until: "2027-01-19T16:00:00.000Z" });
  });

  it("keeps the proposed day for a time alone, and reads today and tomorrow against it", () => {
    expect(at("can we do 1 to 3")).toEqual({ from: "2027-01-12T18:00:00.000Z", until: "2027-01-12T20:00:00.000Z" });
    expect(at("tomorrow 9 to 11")).toEqual({ from: "2027-01-13T14:00:00.000Z", until: "2027-01-13T16:00:00.000Z" });
  });

  it("takes the next such weekday on or after the proposed day", () => {
    expect(at("Tuesday 1-3")).toEqual({ from: "2027-01-12T18:00:00.000Z", until: "2027-01-12T20:00:00.000Z" });
    expect(at("Monday 9-11")).toEqual({ from: "2027-01-18T14:00:00.000Z", until: "2027-01-18T16:00:00.000Z" });
  });

  it("refuses what it can't read confidently", () => {
    for (const text of ["YES", "running late", "Thursday", "next week sometime", "Thursday 3 to 1", "Thursday 9 to 6pm", "Thursday 1 to 3, or Friday 2 to 4", "Feb 30 9-11", "Thursday 9am to 9pm"]) {
      expect(at(text), text).toBeUndefined();
    }
  });
});
