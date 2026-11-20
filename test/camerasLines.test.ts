import { describe, expect, it } from "vitest";
import { cleanCameraLine, latestCounts, memoryLog, type CameraLine } from "../src/cameras/lines";

const motion: CameraLine = { type: "camera", id: "ring-evt-1", at: "2026-11-20T03:14:00.000Z", device: "Front door", deviceId: "dev-aaa", provider: "ring", kind: "motion", label: "human" };

describe("camera lines", () => {
  it("keeps a camera line's fields and nothing else", () => {
    const line = cleanCameraLine({ ...motion, extra: "x", snapshotUrl: "https://signed.example/abc" } as unknown as CameraLine);
    expect(line).toEqual(motion);
  });

  it("refuses a line without an id, a time, a device id or a known kind", () => {
    expect(cleanCameraLine({ ...motion, id: "" })).toBeUndefined();
    expect(cleanCameraLine({ ...motion, at: "soon" })).toBeUndefined();
    expect(cleanCameraLine({ ...motion, deviceId: "" })).toBeUndefined();
    expect(cleanCameraLine({ ...motion, kind: "zoom" } as unknown as CameraLine)).toBeUndefined();
  });

  it("takes long digit runs out of names and labels", () => {
    const line = cleanCameraLine({ ...motion, device: "Gate 12", label: "code 1234" });
    expect(line).toMatchObject({ device: "Gate 12", label: "code [redacted]" });
    expect(cleanCameraLine({ ...motion, device: "Door 44 71" })).toMatchObject({ device: "Door [redacted]" });
  });

  it("checks a count line's whole numbers", () => {
    const count: CameraLine = { type: "camera-count", id: "count:ring-evt-1:vision-v1", at: motion.at, event: "ring-evt-1", counter: "vision-v1", people: 3, vehicles: 1, animals: 0 };
    expect(cleanCameraLine(count)).toEqual(count);
    expect(cleanCameraLine({ ...count, people: -1 })).toBeUndefined();
    expect(cleanCameraLine({ ...count, vehicles: 1.5 })).toBeUndefined();
    expect(cleanCameraLine({ ...count, confidence: "low" })).toMatchObject({ confidence: "low" });
  });

  it("checks a pin line", () => {
    const pin: CameraLine = { type: "camera-pin", id: "pin:1", at: motion.at, event: "ring-evt-1", deviceId: "dev-aaa", from: "2026-11-20T03:13:30.000Z", until: "2026-11-20T03:15:00.000Z", file: "evidence/clip-1.mp4" };
    expect(cleanCameraLine(pin)).toEqual(pin);
    expect(cleanCameraLine({ ...pin, file: "../secrets.json" })).toBeUndefined();
    expect(cleanCameraLine({ ...pin, until: pin.from })).toBeUndefined();
  });
});

describe("the memory log", () => {
  it("writes an id once and keeps lines in order", () => {
    const log = memoryLog();
    expect(log.append(motion)).toBe(true);
    expect(log.append(motion)).toBe(false);
    expect(log.append({ ...motion, id: "ring-evt-2" })).toBe(true);
    expect(log.read().map((line) => line.id)).toEqual(["ring-evt-1", "ring-evt-2"]);
  });

  it("refuses a line that doesn't check", () => {
    const log = memoryLog();
    expect(log.append({ ...motion, deviceId: "" })).toBe(false);
    expect(log.read()).toEqual([]);
  });
});

describe("latest counts", () => {
  it("takes the newest counter's line for each event", () => {
    const log = memoryLog();
    log.append(motion);
    log.append({ type: "camera-count", id: "count:ring-evt-1:vision-v1", at: motion.at, event: "ring-evt-1", counter: "vision-v1", people: 2, vehicles: 0, animals: 0 });
    log.append({ type: "camera-count", id: "count:ring-evt-1:vision-v2", at: motion.at, event: "ring-evt-1", counter: "vision-v2", people: 3, vehicles: 0, animals: 1 });
    expect(latestCounts(log.read()).get("ring-evt-1")).toMatchObject({ people: 3, animals: 1, counter: "vision-v2" });
  });
});
