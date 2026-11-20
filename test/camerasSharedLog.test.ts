import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestCounts } from "../src/cameras/lines";
import { sharedCameraLog } from "../src/cameras/sharedLog";
import { resetVisitLogCache } from "../src/visits/store";

/** #239 writes camera lines into #237's shared log, the same store as lock and message events. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetVisitLogCache();
});

describe("camera lines in the shared visit log", () => {
  it("appends camera, count and pin lines once each, with no flag needed", () => {
    const root = mkdtempSync(join(tmpdir(), "cams-shared-"));
    roots.push(root);
    const now = () => new Date("2026-11-21T03:00:00.000Z");
    const log = sharedCameraLog(root, now);
    const motion = { type: "camera" as const, id: "req-1", at: "2026-11-21T02:14:00.000Z", device: "Front door", deviceId: "dev-aaa", provider: "ring", kind: "motion" as const, label: "human" };
    expect(log.append(motion)).toBe(true);
    expect(log.append(motion)).toBe(false);
    expect(log.append({ type: "camera-count", id: "count:req-1:vision-v1", at: motion.at, event: "req-1", counter: "vision-v1", people: 2, vehicles: 0, animals: 0 })).toBe(true);
    expect(log.append({ type: "camera-pin", id: "pin:req-1", at: now().toISOString(), event: "req-1", deviceId: "dev-aaa", from: "2026-11-21T02:13:30.000Z", until: "2026-11-21T02:15:00.000Z", file: "evidence/clip-req-1.mp4" })).toBe(true);
    const lines = log.read();
    expect(lines.map((line) => line.type)).toEqual(["camera", "camera-count", "camera-pin"]);
    expect(latestCounts(lines).get("req-1")).toMatchObject({ people: 2 });
    expect(readdirSync(join(root, "visit-events"))).toEqual(["2026-11.jsonl"]);
    expect(readFileSync(join(root, "visit-events", "2026-11.jsonl"), "utf8")).not.toMatch(/token|https?:/);
  });
});
