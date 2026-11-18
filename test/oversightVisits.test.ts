import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mayHoldCode } from "../src/hub/codeText";
import { OVERSIGHT_FILE, OversightFileError, readOversight, writeOversight } from "../src/oversight/store";
import { newVisitId, sameVisit, visitProblem, whoMatches } from "../src/oversight/visits";

/** #240: expected visits, their record, and the code-text rule shared with the house rules. Made-up people only. */

const TODAY = "2026-11-17";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "oversight-visits-"));
  roots.push(root);
  return root;
};

describe("expected visits", () => {
  it("accepts a timed visit and an all-day visit", () => {
    expect(visitProblem({ who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" }, TODAY)).toBeUndefined();
    expect(visitProblem({ who: "Mike", date: TODAY }, TODAY)).toBeUndefined();
  });

  it("refuses a past date", () => {
    expect(visitProblem({ who: "Mike", date: "2026-11-16" }, TODAY)).toContain("today or later");
  });

  it("refuses a date that isn't real", () => {
    expect(visitProblem({ who: "Mike", date: "2026-02-31" }, "2026-01-01")).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: "Thursday" }, TODAY)).toBeTypeOf("string");
  });

  it("refuses a half window or a backwards one", () => {
    expect(visitProblem({ who: "Mike", date: TODAY, from: "13:00" }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: TODAY, from: "17:00", to: "13:00" }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: TODAY, from: "13:00", to: "13:00" }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: TODAY, from: "25:00", to: "26:00" }, TODAY)).toBeTypeOf("string");
  });

  it("refuses codes in who and note without repeating them", () => {
    const note = visitProblem({ who: "Mike", date: TODAY, note: "door 6150" }, TODAY);
    expect(note).toContain("note");
    expect(note).not.toContain("6150");
    const who = visitProblem({ who: "Mike 61-50", date: TODAY }, TODAY);
    expect(who).toContain("who");
    expect(who).not.toContain("6150");
    expect(who).not.toContain("61-50");
    expect(visitProblem({ who: "Mike", date: TODAY, note: "Quiet 22:00-07:00 check" }, TODAY)).toBeUndefined();
  });

  it("checks lengths", () => {
    expect(visitProblem({ who: "M".repeat(61), date: TODAY }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: TODAY, note: "n".repeat(201) }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "  ", date: TODAY }, TODAY)).toBeTypeOf("string");
    expect(visitProblem({ who: "Mike", date: TODAY, note: "" }, TODAY)).toBeTypeOf("string");
    expect(visitProblem("Mike", TODAY)).toBeTypeOf("string");
  });

  it("matches names ignoring case and spacing", () => {
    expect(whoMatches("Mike Doyle", "mike  doyle")).toBe(true);
    expect(whoMatches("Mike", "Mike Doyle")).toBe(true);
    expect(whoMatches("Mike Doyle", "Mike")).toBe(true);
    expect(whoMatches("Mike Doyle", "Sam Ortiz")).toBe(false);
    expect(whoMatches("Mike Doyle", "Mike Ortiz")).toBe(false);
  });

  it("knows the same visit", () => {
    const visit = { who: "Mike", date: TODAY, from: "13:00", to: "17:00" };
    expect(sameVisit(visit, { ...visit, who: " mike " })).toBe(true);
    expect(sameVisit(visit, { ...visit, to: "18:00" })).toBe(false);
  });

  it("makes short visit ids", () => {
    expect(newVisitId()).toMatch(/^v-[0-9a-f]{8}$/);
  });
});

describe("the code-text rule", () => {
  it("catches long numbers and spares clock times", () => {
    expect(mayHoldCode("door 6150")).toBe(true);
    expect(mayHoldCode("48 21 at the side")).toBe(true);
    expect(mayHoldCode("Quiet 22:00-07:00")).toBe(false);
    expect(mayHoldCode("6 guests")).toBe(false);
  });
});

describe("the record", () => {
  it("starts empty and keeps what's written", () => {
    const root = temp();
    expect(readOversight(root)).toEqual({ visits: [] });
    const visit = { id: "v-0a1b2c3d", who: "Mike", date: TODAY, source: "text" as const, savedAt: "2026-11-17T15:00:00.000Z" };
    writeOversight(root, { visits: [visit] });
    expect(readOversight(root).visits).toEqual([visit]);
  });

  it("refuses a record whose visits aren't a list, and leaves it", () => {
    const root = temp();
    const raw = JSON.stringify({ visits: { "v-1": { id: "v-1", who: "Mike", date: TODAY } } });
    writeFileSync(join(root, OVERSIGHT_FILE), raw);
    expect(() => readOversight(root)).toThrow(OversightFileError);
    expect(readFileSync(join(root, OVERSIGHT_FILE), "utf8")).toBe(raw);
  });

  it("refuses a record with a visit that isn't one", () => {
    const root = temp();
    for (const bad of [null, "v-1", { id: "v-1", who: "Mike" }, { id: 7, who: "Mike", date: TODAY }]) {
      writeFileSync(join(root, OVERSIGHT_FILE), JSON.stringify({ visits: [bad] }));
      expect(() => readOversight(root)).toThrow(OversightFileError);
    }
  });

  it("refuses an unreadable record and leaves it", () => {
    const root = temp();
    writeFileSync(join(root, OVERSIGHT_FILE), "{nope");
    expect(() => readOversight(root)).toThrow(OversightFileError);
    expect(readFileSync(join(root, OVERSIGHT_FILE), "utf8")).toBe("{nope");
  });
});
