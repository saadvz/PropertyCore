import { describe, expect, it } from "vitest";
import { exportRows, formatReport, fromCsv, isNight, scoreRows, toCsv } from "../src/cameras/countTest";
import type { StoredLine } from "../src/cameras/lines";

/** #239: the one-week counting test: export our counts for the host to fill in, then score them. Made-up events. */

const TZ = "America/New_York";
const motion = (id: string, at: string, label = "human") => ({ type: "camera", id, at, device: "Front door", deviceId: "dev-aaa", provider: "ring", kind: "motion", label }) as unknown as StoredLine;
const count = (event: string, people: number, vehicles = 0, animals = 0) => ({ type: "camera-count", id: `count:${event}:vision-v1`, at: "x", event, counter: "vision-v1", people, vehicles, animals }) as unknown as StoredLine;

describe("exporting the week", () => {
  it("one row per counted event, in local time, with empty columns for the host; no links or images", () => {
    const lines = [motion("e1", "2026-11-21T02:14:00.000Z"), count("e1", 3, 1, 0), motion("e2", "2026-11-21T17:00:00.000Z", "vehicle"), count("e2", 0, 2, 0), motion("e3", "2026-11-21T18:00:00.000Z"), motion("pk", "2026-11-21T18:00:00.000Z", "package_delivery")];
    const rows = exportRows(lines, { timeZone: TZ, from: "2026-11-20", to: "2026-11-27" });
    expect(rows.map((row) => row.eventId)).toEqual(["e1", "e2"]);
    expect(rows[0]).toMatchObject({ localDate: "2026-11-20", localTime: "21:14", camera: "Front door", label: "human", period: "night", ours: { people: 3, vehicles: 1, animals: 0 } });
    expect(rows[1]).toMatchObject({ localTime: "12:00", period: "day" });
    const csv = toCsv(rows);
    expect(csv.split("\n")[0]).toBe("event_id,local_date,local_time,camera,label,period,our_people,our_vehicles,our_animals,host_people,host_vehicles,host_animals,note");
    expect(csv).not.toMatch(/https?:|\.jpg|\.mp4/);
  });

  it("night is after sunset and before sunrise for the month", () => {
    expect(isNight("2026-11-20", "17:30")).toBe(true);
    expect(isNight("2026-11-20", "12:00")).toBe(false);
    expect(isNight("2026-06-20", "19:30")).toBe(false);
    expect(isNight("2026-06-20", "04:30")).toBe(true);
  });
});

describe("scoring the host's sheet", () => {
  const csv = [
    "event_id,local_date,local_time,camera,label,period,our_people,our_vehicles,our_animals,host_people,host_vehicles,host_animals,note",
    "e1,2026-11-20,21:14,Front door,human,night,3,1,0,3,1,0,",
    "e2,2026-11-20,22:00,Front door,human,night,5,0,0,4,0,1,a dog by the car",
    "e3,2026-11-21,12:00,Driveway,vehicle,day,0,2,0,0,2,0,",
    "e4,2026-11-21,13:00,Driveway,human,day,2,0,0,,,,host skipped",
    '"e5","2026-11-21","14:00","Front door, side","human","day","1","0","0","1","0","0","quoted, with a comma"',
  ].join("\n");

  it("reads a filled sheet, skipping rows the host left blank", () => {
    const rows = fromCsv(csv);
    expect(rows).toHaveLength(5);
    expect(rows[3]!.host).toBeUndefined();
    expect(rows[4]).toMatchObject({ camera: "Front door, side", note: "quoted, with a comma" });
  });

  it("scores exact, within one, over and under, day and night apart, and the night peak", () => {
    const score = scoreRows(fromCsv(csv));
    expect(score.byPeriod.night.people).toEqual({ rows: 2, exact: 1, withinOne: 2, over: 1, under: 0 });
    expect(score.byPeriod.night.animals).toEqual({ rows: 2, exact: 1, withinOne: 2, over: 0, under: 1 });
    expect(score.byPeriod.day.vehicles).toEqual({ rows: 2, exact: 2, withinOne: 2, over: 0, under: 0 });
    expect(score.scored).toBe(4);
    expect(score.blank).toBe(1);
    // Night of the 20th: ours peak 5 people, host's 4.
    expect(score.nightPeaks.people).toEqual({ nights: 2, exact: 1, over: 1, under: 0 });
    const report = formatReport(score);
    expect(report).toContain("people");
    expect(report).toMatch(/night peak/i);
  });
});

describe("the command line", () => {
  it("reads the shared log's month files read-only, skipping a bad line, and runs export then score", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readLogLines, runCountTest } = await import("../src/cameras/countTestCli");
    const root = mkdtempSync(join(tmpdir(), "count-test-"));
    mkdirSync(join(root, "visit-events"));
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", timeZone: TZ }, calendars: [], stays: [] }));
    writeFileSync(join(root, "visit-events", "2026-11.jsonl"), [JSON.stringify(motion("e1", "2026-11-21T02:14:00.000Z")), "not json", JSON.stringify(count("e1", 2))].join("\n") + "\n");
    expect(readLogLines(root).map((line) => line.id)).toEqual(["e1", "count:e1:vision-v1"]);
    const out = join(root, "sheet.csv");
    const said: string[] = [];
    await runCountTest(["export", "--root", root, "--from", "2026-11-20", "--to", "2026-11-27", "--out", out], (text) => said.push(text));
    expect(readFileSync(out, "utf8")).toContain("e1,2026-11-20,21:14");
    writeFileSync(out, readFileSync(out, "utf8").replace("e1,2026-11-20,21:14,Front door,human,night,2,0,0,,,,", "e1,2026-11-20,21:14,Front door,human,night,2,0,0,2,0,0,"));
    await runCountTest(["score", "--file", out], (text) => said.push(text));
    expect(said.join("\n")).toMatch(/1 events scored/);
  });
});
