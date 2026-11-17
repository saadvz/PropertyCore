import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTimeProblem, markFalse, needed, rulesProblem, type HouseRule } from "../src/stay-check/rules";
import { readStayCheck, STAY_CHECK_FILE, StayCheckFileError, writeStayCheck, type StayCheckFile } from "../src/stay-check/store";

/** #239: the host's own house rules, checked before they're saved, and the record they live in. */

const empty = (): StayCheckFile => ({ rules: [], sightings: {}, allowances: [] });
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "stay-check-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("house rules", () => {
  it("accepts the host's words with and without checks", () => {
    const rules: HouseRule[] = [
      { text: "No more than 6 guests", check: { kind: "people", max: 6 } },
      { text: "No smoking" },
    ];
    expect(rulesProblem(rules)).toBeUndefined();
    expect(rulesProblem([{ text: "Booked guests only", check: { kind: "people" } }, { text: "No pets", check: { kind: "pets" } }, { text: "Two cars max", check: { kind: "vehicles", max: 2 } }, { text: "Quiet after 10 PM", check: { kind: "quiet", start: "22:00", end: "07:00", noiseLimit: 70 } }])).toBeUndefined();
    expect(rulesProblem([])).toBeUndefined();
  });

  it("refuses a second check of the same kind", () => {
    const problem = rulesProblem([
      { text: "Two cars max", check: { kind: "vehicles", max: 2 } },
      { text: "One car on weekdays", check: { kind: "vehicles", max: 1 } },
    ]);
    expect(problem).toContain("vehicles");
  });

  it("refuses out-of-range values", () => {
    const one = (check: unknown) => rulesProblem([{ text: "A rule", check }]);
    expect(one({ kind: "people", max: 0 })).toBeTypeOf("string");
    expect(one({ kind: "people", max: 51 })).toBeTypeOf("string");
    expect(one({ kind: "people", max: 2.5 })).toBeTypeOf("string");
    expect(one({ kind: "vehicles", max: 21 })).toBeTypeOf("string");
    expect(one({ kind: "vehicles" })).toBeTypeOf("string");
    expect(one({ kind: "quiet", start: "22:00", end: "07:00", noiseLimit: 29 })).toBeTypeOf("string");
    expect(one({ kind: "quiet", start: "22:00", end: "07:00", noiseLimit: 121 })).toBeTypeOf("string");
    expect(one({ kind: "quiet", start: "25:00", end: "07:00" })).toBeTypeOf("string");
    expect(one({ kind: "quiet", start: "22:00", end: "22:00" })).toBeTypeOf("string");
    expect(one({ kind: "smoke" })).toBeTypeOf("string");
    expect(one({ kind: "vehicles", max: 0 })).toBeUndefined();
  });

  it("refuses rule text that may hold a door code", () => {
    const text = (words: string) => rulesProblem([{ text: words }]);
    // Made-up digits, built from parts so the repo's door-code scan doesn't read them as a code.
    const d = ["4", "8", "2", "1"];
    expect(text(`Lockbox ${d.join("")}`)).toBeTypeOf("string");
    expect(text(`Front ${d[0]}${d[1]} ${d[2]}${d[3]}`)).toBeTypeOf("string");
    expect(text(`Use ${d.join("-")} at the side`)).toBeTypeOf("string");
    expect(text(`Gate code ${d.slice(0, 3).join("")}`)).toBeTypeOf("string");
    expect(text("Quiet after 10 PM")).toBeUndefined();
    expect(text("6 guests")).toBeUndefined();
    expect(text("Quiet 22:00 to 08:00")).toBeUndefined();
  });

  it("accepts clock times in quiet hours wording", () => {
    expect(rulesProblem([{ text: "Quiet hours 22:00-07:00" }])).toBeUndefined();
    expect(rulesProblem([{ text: "Check-in 15:00-22:00, no early arrivals" }])).toBeUndefined();
    expect(rulesProblem([{ text: `Lockbox ${["4", "8", "2", "1"].join("")}, quiet 22:00-07:00` }])).toBeTypeOf("string");
  });

  it("a refusal doesn't repeat the digits", () => {
    const digits = ["4", "8", "2", "1"].join(" ");
    const problem = rulesProblem([{ text: "No smoking" }, { text: `Door code is ${digits}` }]);
    expect(problem).toBeTypeOf("string");
    expect(problem).not.toContain(digits);
    expect(problem).not.toContain("Door code is");
  });

  it("refuses more than 20 rules and empty or long text", () => {
    expect(rulesProblem(Array.from({ length: 21 }, (_, i) => ({ text: `Rule ${i}` })))).toBeTypeOf("string");
    expect(rulesProblem(Array.from({ length: 20 }, (_, i) => ({ text: `Rule ${i}` })))).toBeUndefined();
    expect(rulesProblem([{ text: "" }])).toBeTypeOf("string");
    expect(rulesProblem([{ text: "   " }])).toBeTypeOf("string");
    expect(rulesProblem([{ text: "x".repeat(201) }])).toBeTypeOf("string");
    expect(rulesProblem([{ text: "x".repeat(200) }])).toBeUndefined();
    expect(rulesProblem("No pets")).toBeTypeOf("string");
    expect(rulesProblem([null])).toBeTypeOf("string");
  });

  it("checks the check time", () => {
    expect(checkTimeProblem("23:00")).toBeUndefined();
    expect(checkTimeProblem("02:00")).toBeUndefined();
    expect(checkTimeProblem("11 PM")).toBeTypeOf("string");
    expect(checkTimeProblem("24:00")).toBeTypeOf("string");
  });

  it("markFalse raises needed sightings to 3 and stops", () => {
    const once = markFalse(empty(), "people");
    expect(once.sightings.people).toBe(2);
    const twice = markFalse(once, "people");
    expect(twice.sightings.people).toBe(3);
    expect(markFalse(twice, "people").sightings.people).toBe(3);
    expect(needed({}, "pets")).toBe(1);
    expect(needed(twice.sightings, "people")).toBe(3);
    expect(empty().sightings.people).toBeUndefined();
  });
});

describe("the record", () => {
  it("starts empty and keeps what's written", () => {
    const root = temp();
    expect(readStayCheck(root)).toEqual(empty());
    const file: StayCheckFile = { rules: [{ text: "No pets", check: { kind: "pets" } }], checkTime: "22:30", sightings: { pets: 2 }, allowances: [{ checkIn: "2026-11-20", allow: ["pets"] }] };
    writeStayCheck(root, file);
    expect(readStayCheck(root)).toEqual(file);
  });

  it("refuses an unreadable record and leaves it", () => {
    const root = temp();
    const path = join(root, STAY_CHECK_FILE);
    writeFileSync(path, "{not json");
    expect(() => readStayCheck(root)).toThrow(StayCheckFileError);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
