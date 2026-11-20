import { describe, expect, it } from "vitest";
import { fakeCameraProvider } from "../src/cameras/fake";
import { CameraCounting, countable } from "../src/cameras/count";
import { fakeCounter } from "../src/cameras/counter";
import { latestCounts, memoryLog, type CameraEventLine } from "../src/cameras/lines";

const line = (id: string, at: string, label?: string): CameraEventLine => ({ type: "camera", id, at, device: "Front door", deviceId: "dev-aaa", provider: "fake", kind: "motion", ...(label ? { label } : {}) });
const tokens = { get: () => ({ access: "a", refresh: "r", expiresAt: Number.MAX_SAFE_INTEGER }), save: () => {} };

function setup(options: { inStay?: (at: string) => boolean; cap?: number } = {}) {
  const provider = fakeCameraProvider();
  const log = memoryLog();
  const counter = fakeCounter(() => ({ people: 4, vehicles: 1, animals: 0 }));
  const counting = new CameraCounting({ provider, account: { tokens }, counter, log, inStay: options.inStay ?? (() => true), nightOf: (at) => at.slice(0, 10), ...(options.cap ? { cap: options.cap } : {}) });
  return { provider, log, counter, counting };
}

describe("which events are counted", () => {
  it("counts people, vehicles, other motion and plain motion, not packages or the doorbell", () => {
    expect(countable(line("1", "2026-11-20T03:00:00Z", "human"))).toBe(true);
    expect(countable(line("1", "2026-11-20T03:00:00Z", "vehicle"))).toBe(true);
    expect(countable(line("1", "2026-11-20T03:00:00Z", "other_motion"))).toBe(true);
    expect(countable(line("1", "2026-11-20T03:00:00Z", "motion"))).toBe(true);
    expect(countable(line("1", "2026-11-20T03:00:00Z"))).toBe(true);
    expect(countable(line("1", "2026-11-20T03:00:00Z", "package_delivery"))).toBe(false);
    expect(countable({ ...line("1", "2026-11-20T03:00:00Z"), kind: "ding" })).toBe(false);
  });
});

describe("the counting pass", () => {
  it("counts each event in a stay once, writes a count line and keeps no image", async () => {
    const { log, provider, counting } = setup();
    log.append(line("e1", "2026-11-20T03:00:00.000Z", "human"));
    expect(await counting.run()).toEqual({ counted: 1, failed: 0, waiting: 0 });
    expect(await counting.run()).toEqual({ counted: 0, failed: 0, waiting: 0 });
    const counts = latestCounts(log.read());
    expect(counts.get("e1")).toMatchObject({ people: 4, vehicles: 1, animals: 0, counter: "fake-v1", id: "count:e1:fake-v1" });
    expect(provider.calls.filter((call) => call.call === "snapshot")).toHaveLength(1);
    expect(JSON.stringify(log.read())).not.toMatch(/255|ffd8|image/i);
  });

  it("skips events outside a stay", async () => {
    const { log, counting } = setup({ inStay: () => false });
    log.append(line("e1", "2026-11-20T03:00:00.000Z", "human"));
    expect(await counting.run()).toEqual({ counted: 0, failed: 0, waiting: 0 });
  });

  it("retries a failed snapshot twice across runs, then leaves it uncounted", async () => {
    const { log, provider, counting } = setup();
    provider.failSnapshots = 10;
    log.append(line("e1", "2026-11-20T03:00:00.000Z", "human"));
    expect(await counting.run()).toMatchObject({ failed: 1 });
    expect(await counting.run()).toMatchObject({ failed: 1 });
    expect(await counting.run()).toMatchObject({ failed: 1 });
    expect(await counting.run()).toMatchObject({ failed: 0, counted: 0 });
    expect(provider.calls.filter((call) => call.call === "snapshot")).toHaveLength(3);
    expect(latestCounts(log.read()).size).toBe(0);
  });

  it("counts at most the cap a night and leaves the rest waiting", async () => {
    const { log, counting } = setup({ cap: 2 });
    for (let i = 0; i < 4; i++) log.append(line(`e${i}`, `2026-11-20T03:0${i}:00.000Z`, "human"));
    expect(await counting.run()).toEqual({ counted: 2, failed: 0, waiting: 2 });
    expect(await counting.run()).toEqual({ counted: 0, failed: 0, waiting: 2 });
  });
});

describe("overlapping passes", () => {
  it("runs one pass at a time, so overlapping calls never fetch or count an event twice", async () => {
    const provider = fakeCameraProvider();
    const log = memoryLog();
    let calls = 0;
    const counter = { name: "slow-v1", async count() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { people: 1, vehicles: 0, animals: 0 }; } };
    const counting = new CameraCounting({ provider, account: { tokens }, counter, log, inStay: () => true, nightOf: (at) => at.slice(0, 10) });
    for (let i = 0; i < 3; i++) log.append(line(`e${i}`, `2026-11-20T03:0${i}:00.000Z`, "human"));
    await Promise.all([counting.run(), counting.run(), counting.run(), counting.run()]);
    expect(calls).toBe(3);
    expect(provider.calls.filter((call) => call.call === "snapshot")).toHaveLength(3);
  });
});

describe("two counters on the same events", () => {
  it("each counter counts each event once, so the counting test can compare them", async () => {
    const provider = fakeCameraProvider();
    const log = memoryLog();
    log.append(line("e1", "2026-11-20T03:00:00.000Z", "human"));
    const make = (name: string, people: number) => new CameraCounting({ provider, account: { tokens }, counter: fakeCounter(() => ({ people, vehicles: 0, animals: 0 }), name), log, inStay: () => true, nightOf: (at) => at.slice(0, 10) });
    expect(await make("rfdetr-medium-t50-v1", 3).run()).toMatchObject({ counted: 1 });
    expect(await make("detector-v1", 2).run()).toMatchObject({ counted: 1 });
    expect(await make("detector-v1", 2).run()).toMatchObject({ counted: 0 });
    expect(latestCounts(log.read(), "rfdetr-medium-t50-v1").get("e1")).toMatchObject({ people: 3 });
    expect(latestCounts(log.read(), "detector-v1").get("e1")).toMatchObject({ people: 2 });
  });
});
