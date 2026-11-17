import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { visitFromInvite } from "../src/oversight/invite";

/** #240: an expected visit read from a calendar invite, in the property's time zone. Made-up invites only. */

const NY = "America/New_York";
const invite = (name: string) => readFileSync(join(__dirname, "fixtures", "oversight", `${name}.ics`), "utf8");

describe("reading a calendar invite", () => {
  it("reads a TZID invite in the property's zone", () => {
    expect(visitFromInvite(invite("timed-tzid"), NY)).toEqual({ ok: true, visit: { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "Walk-through" } });
  });

  it("never keeps the description or location", () => {
    const text = JSON.stringify(visitFromInvite(invite("timed-tzid"), NY));
    expect(text).not.toContain("Gate");
    expect(text).not.toContain("Scratch Lane");
  });

  it("converts a UTC invite and unescapes the title", () => {
    expect(visitFromInvite(invite("timed-utc"), NY)).toEqual({ ok: true, visit: { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "Check the furnace, and the filter" } });
  });

  it("reads an all-day invite", () => {
    expect(visitFromInvite(invite("all-day"), NY)).toEqual({ ok: true, visit: { who: "Mike Doyle", date: "2026-11-20", note: "Stop by" } });
  });

  it("takes a floating time as local and leaves who unset", () => {
    expect(visitFromInvite(invite("floating"), NY)).toEqual({ ok: true, visit: { date: "2026-11-19", from: "09:00", to: "10:00", note: "Look at the gutters" } });
  });

  it("reads an end at midnight as 23:59 the same day", () => {
    expect(visitFromInvite(invite("until-midnight"), NY)).toMatchObject({ ok: true, visit: { date: "2026-11-19", from: "22:00", to: "23:59" } });
  });

  it("refuses a cancelled invite", () => {
    expect(visitFromInvite(invite("cancelled"), NY).ok).toBe(false);
  });

  it("refuses an invite over more than one day", () => {
    const read = visitFromInvite(invite("multi-day"), NY);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("one day");
  });

  it("refuses a time zone it can't read rather than guess", () => {
    const read = visitFromInvite(invite("windows-zone"), NY);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("time zone");
  });

  it("refuses a repeating invite", () => {
    const read = visitFromInvite(invite("repeating"), NY);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("repeat");
  });

  it("refuses text that isn't an invite", () => {
    expect(visitFromInvite("Mike will stop by Thursday", NY).ok).toBe(false);
  });

  it("leaves out a title that may hold a code", () => {
    const read = visitFromInvite(invite("code-title"), NY);
    expect(read).toEqual({ ok: true, visit: { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "14:00" }, titleLeftOut: true });
    expect(JSON.stringify(read)).not.toContain("6150");
  });

  it("catches a code that crosses the title's 200-character cut", () => {
    const title = `${"a".repeat(197)} 6150 b`;
    const ics = invite("timed-tzid").replace("SUMMARY:Walk-through", `SUMMARY:${title}`);
    const read = visitFromInvite(ics, NY);
    expect(read).toMatchObject({ ok: true, titleLeftOut: true });
    if (read.ok) expect(read.visit.note).toBeUndefined();
  });

  it("reads an invite sent with CRLF line endings and folded lines", () => {
    const crlf = invite("timed-tzid").replace(/\r?\n/g, "\r\n").replace("SUMMARY:Walk-through", "SUMMARY:Walk-\r\n through");
    expect(visitFromInvite(crlf, NY)).toEqual({ ok: true, visit: { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "Walk-through" } });
  });

  it("reads the day in the property's zone", () => {
    expect(visitFromInvite(invite("timed-utc"), "America/Los_Angeles")).toMatchObject({ ok: true, visit: { date: "2026-11-19", from: "10:00", to: "14:00" } });
  });
});
